import { Hono, type Context, type MiddlewareHandler } from "hono";
import type postgres from "postgres";
import {
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { AgentRepository } from "@x1agent/domain-agents";
import {
  SessionId,
  resolveSessionVisibility,
  pickSessionListMode,
  type SessionEventRepository,
  type SessionRepository,
  type SessionShareRepository,
  type AdminGuard,
} from "@x1agent/domain-sessions";
import { getMimeType, readShareFile } from "./storage.js";

/**
 * Workspace-scoped read side of the share subsystem.
 *
 * Mount point: `/api/workspaces/:slug/sessions/:sessionId/shares`.
 * Write side is under `/api/internal/sessions/:sessionId/shares` — the
 * sidecar is the only caller and authenticates with the internal token.
 *
 *   GET /          — list every `agent.share` event for this session
 *   GET /:shareId/*
 *                  — proxy a single file out of the share's directory
 *                    (or the share's GCS prefix in prod)
 */
export interface WorkspaceShareRoutesConfig {
  sessions: SessionRepository;
  events: SessionEventRepository;
  agents: AgentRepository;
  adminGuard: AdminGuard;
  /**
   * Per-user share grants — used by the visibility check so a non-admin
   * sharee can fetch the artefacts of a session granted to them. Without
   * this the route degrades to admin+owner only (still secure, just
   * less useful).
   */
  shares?: SessionShareRepository;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
  /**
   * GCS bucket. When set, the api fetches the file from GCS using the
   * pod's service-account token and streams it back to the browser.
   * Unset in dev — we read from local disk instead.
   */
  gcsArtifactsBucket?: string;
}

export function createWorkspaceShareRoutes(
  cfg: WorkspaceShareRoutesConfig,
): Hono {
  const app = new Hono();

  // Iframes and <img> tags can't set an Authorization header, and
  // cross-port cookies don't ride along in dev. To make a site-share
  // iframe work, we accept the JWT as a `?token=` query param and
  // promote it onto the Authorization header before requireAuth runs.
  // Safe because requireAuth still verifies it with the tokenizer — a
  // forged or expired token fails the same way whether it arrived as
  // a header or query param.
  app.use("*", async (c, next) => {
    const existing =
      c.req.header("Authorization") ||
      c.req.header("Cookie")?.includes("x1_session=");
    if (!existing) {
      const qs = c.req.query("token");
      if (qs) {
        c.req.raw.headers.set("Authorization", `Bearer ${qs}`);
      }
    }
    await next();
  });
  app.use("*", cfg.requireAuth);

  const loadScoped = async (
    slugRaw: string,
    sessionIdRaw: string,
    actorId: UserId,
  ): Promise<
    | {
        session: NonNullable<
          Awaited<ReturnType<SessionRepository["findById"]>>
        >;
      }
    | { error: "workspace_not_found" | "session_not_found" }
  > => {
    let wsId: WorkspaceId | null = null;
    try {
      wsId = await cfg.resolveWorkspace(WorkspaceSlug(slugRaw));
    } catch {
      return { error: "workspace_not_found" };
    }
    if (!wsId) return { error: "workspace_not_found" };
    const session = await cfg.sessions.findById(SessionId(sessionIdRaw));
    if (!session) return { error: "session_not_found" };
    const agent = await cfg.agents.findById(session.agentId);
    if (!agent || agent.workspaceId !== wsId)
      return { error: "session_not_found" };
    // Owner ∪ admin ∪ sharee — the same primitive as
    // createWorkspaceSessionRoutes. Pre-fix, this route was admin-only,
    // which meant a session owner could see the event stream but not
    // the share artefacts that the session emitted (X1A-9).
    const decision = await resolveSessionVisibility(
      { adminGuard: cfg.adminGuard, shares: cfg.shares },
      actorId,
      session,
      agent.workspaceId,
    );
    if (!decision.visible) return { error: "session_not_found" };
    return { session };
  };

  // List every share published in this session. Derived from
  // `agent.share` events so the list survives indefinitely — as long as
  // the event is persisted, the share stays listable, even after the pod
  // is gone.
  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const scope = await loadScoped(
      c.req.param("slug")!,
      c.req.param("sessionId")!,
      actor.userId,
    );
    if ("error" in scope) {
      return c.json({ error: scope.error }, 404);
    }
    // 5000 is the max allowed by the domain layer; shares are sparse
    // compared to message events so the real cap is closer to a few
    // hundred per session in practice.
    const events = await cfg.events.listBySession(scope.session.id, {
      limit: 5000,
    });
    const shares = events
      .filter((e) => e.type === "agent.share")
      .map((e) => ({
        ...(typeof e.payload === "string"
          ? (JSON.parse(e.payload) as Record<string, unknown>)
          : (e.payload as Record<string, unknown>)),
        created_at: e.timestamp.toISOString(),
      }));
    return c.json({ shares });
  });

  // Stream a single file out of the share. For sites (share_type: "site")
  // this serves the HTML entry point and all its static assets; for all
  // other types the UI fetches a single known path.
  app.get("/:shareId/*", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const scope = await loadScoped(
      c.req.param("slug")!,
      c.req.param("sessionId")!,
      actor.userId,
    );
    if ("error" in scope) {
      return c.json({ error: scope.error }, 404);
    }

    const shareId = c.req.param("shareId")!;
    const slug = c.req.param("slug")!;
    const sessionId = scope.session.id;
    // The Hono param can't capture the wildcard remainder directly, so
    // slice after the known prefix. Missing path means "index.html" —
    // matches how a browser dereferences a bare iframe src.
    const prefix = `/api/workspaces/${slug}/sessions/${sessionId}/shares/${shareId}/`;
    const idx = c.req.path.indexOf(prefix);
    let filePath =
      idx >= 0 ? c.req.path.slice(idx + prefix.length) : "";
    if (!filePath) filePath = "index.html";

    // CORS headers need to land on the raw Response we build below.
    // Hono's global CORS middleware only sets headers via c.header(),
    // which is bypassed when a handler returns `new Response(...)`
    // directly. So we pull the origin from the request and echo it —
    // cookies ride when Allow-Credentials + an exact Allow-Origin are
    // both set. Mirrors the app-wide middleware in
    // packages/api/src/index.ts.
    const corsOrigin =
      c.req.header("Origin") ?? process.env.PUBLIC_URL ?? "";
    const corsHeaders: Record<string, string> = corsOrigin
      ? {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin",
        }
      : {};

    if (cfg.gcsArtifactsBucket) {
      return serveFromGcs(
        cfg.gcsArtifactsBucket,
        sessionId,
        shareId,
        filePath,
        corsHeaders,
      );
    }

    const bytes = readShareFile(sessionId, shareId, filePath);
    if (!bytes) return c.json({ error: "not_found" }, 404);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": getMimeType(filePath),
        "Cache-Control": "public, max-age=86400",
        ...corsHeaders,
      },
    });
  });

  return app;
}

/**
 * Workspace-level shares index. Lists every `agent.share` event in the
 * workspace, joined with the originating session + agent so the page
 * can link back. Sorted newest-first; capped at 500 rows because the
 * UI paginates client-side.
 *
 * Mount point: `/api/workspaces/:slug/shares`.
 *
 * Visibility (X1A-9): an admin sees every share in the workspace; a
 * non-admin sees only shares from sessions visible to them — sessions
 * they own (`triggered_by_user_id = actor`) or were explicitly granted
 * via `session_user_shares`. The two branches share everything but the
 * `WHERE` clause; the rule itself is decided by `pickSessionListMode`
 * so adding group-share support later is a single-site change.
 */
export interface WorkspaceSharesIndexConfig {
  sql: postgres.Sql<Record<string, unknown>>;
  adminGuard: AdminGuard;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

interface SharesIndexRow {
  session_id: string;
  agent_id: string;
  agent_slug: string;
  agent_name: string;
  session_triggered_at: Date | string;
  payload: unknown;
  created_at: Date | string;
}

export function createWorkspaceSharesIndexRoutes(
  cfg: WorkspaceSharesIndexConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    let wsId: WorkspaceId | null = null;
    try {
      wsId = await cfg.resolveWorkspace(WorkspaceSlug(c.req.param("slug")!));
    } catch {
      return c.json({ error: "workspace_not_found" }, 404);
    }
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    // Admin → full workspace list. Non-admin → join through
    // session_user_shares and OR with owner-of-session. The unique
    // index on (session_id, user_id) means the LEFT JOIN cannot fan
    // out, so DISTINCT isn't needed.
    const listMode = await pickSessionListMode(
      { adminGuard: cfg.adminGuard },
      actor.userId,
      wsId,
    );
    const rows =
      listMode.mode === "all"
        ? await cfg.sql<SharesIndexRow[]>`
            SELECT
              se.session_id,
              s.agent_id,
              a.slug AS agent_slug,
              a.name AS agent_name,
              s.triggered_at AS session_triggered_at,
              se.payload,
              se.created_at
            FROM session_events se
            JOIN sessions s ON s.id = se.session_id
            JOIN agents a ON a.id = s.agent_id
            WHERE a.workspace_id = ${wsId}
              AND se.type = 'agent.share'
            ORDER BY se.created_at DESC
            LIMIT 500
          `
        : await cfg.sql<SharesIndexRow[]>`
            SELECT
              se.session_id,
              s.agent_id,
              a.slug AS agent_slug,
              a.name AS agent_name,
              s.triggered_at AS session_triggered_at,
              se.payload,
              se.created_at
            FROM session_events se
            JOIN sessions s ON s.id = se.session_id
            JOIN agents a ON a.id = s.agent_id
            LEFT JOIN session_user_shares us
              ON us.session_id = s.id AND us.user_id = ${listMode.userId}
            WHERE a.workspace_id = ${wsId}
              AND se.type = 'agent.share'
              AND (
                s.triggered_by_user_id = ${listMode.userId}
                OR us.id IS NOT NULL
              )
            ORDER BY se.created_at DESC
            LIMIT 500
          `;
    const shares = rows.map((r) => {
      const payload =
        typeof r.payload === "string"
          ? (JSON.parse(r.payload) as Record<string, unknown>)
          : (r.payload as Record<string, unknown>);
      return {
        ...payload,
        session_id: r.session_id,
        session_triggered_at: new Date(r.session_triggered_at).toISOString(),
        agent: { id: r.agent_id, slug: r.agent_slug, name: r.agent_name },
        created_at: new Date(r.created_at).toISOString(),
      };
    });
    return c.json({ shares });
  });

  return app;
}

/**
 * Production path: fetch a service-account token from the GCE metadata
 * server and stream the object back to the browser with the right MIME
 * type. The pod service account needs `storage.objectViewer` on the
 * bucket for this to work.
 */
async function serveFromGcs(
  bucket: string,
  sessionId: string,
  shareId: string,
  filePath: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const objectName = `sessions/${sessionId}/shares/${shareId}/${filePath}`;
    const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}?alt=media`;

    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    const tokenBody = (await tokenRes.json()) as { access_token?: string };
    const token = tokenBody.access_token;
    if (!token) {
      return new Response(JSON.stringify({ error: "gcs_auth_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    const res = await fetch(gcsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    return new Response(res.body, {
      headers: {
        "Content-Type": getMimeType(filePath),
        "Cache-Control": "public, max-age=86400",
        ...corsHeaders,
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "gcs_fetch_failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}

