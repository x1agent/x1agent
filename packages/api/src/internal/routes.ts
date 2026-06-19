import { Hono, type MiddlewareHandler } from "hono";
import { DomainError, systemClock } from "@x1agent/kernel";
import type { GitHubAppClient, InstallationId } from "@x1agent/domain-github";
import { AgentId, type AgentRepository } from "@x1agent/domain-agents";
import type {
  AgentCostWindow,
  JobTerminator,
  SessionEventRepository,
  SessionRepository,
  TokenUsageRepository,
} from "@x1agent/domain-sessions";
import {
  NotYourChildError,
  SessionId,
  appendSessionEvent,
  cancelChildSession,
  spawnChildSession,
} from "@x1agent/domain-sessions";
import {
  SPAWN_GRANT_TYPE,
  findActiveGrant,
  type PermissionGrantRepository,
} from "@x1agent/domain-permissions";
import {
  downloadShareFromGcs,
  getMimeType,
  readShareFile,
  readStagingFile,
  writeShareFiles,
  writeStagingFiles,
} from "../shares/storage.js";
import { resumeChainSessionIds } from "../shares/resume-chain.js";
import { StringCodec, JSONCodec } from "nats";
import type { KubeConfig } from "@kubernetes/client-node";
import { pullFromChild } from "../k8s/pull-from-child.js";
import { randomUUID } from "node:crypto";
import type {
  UploadRepository,
  UploadStorage,
} from "@x1agent/domain-uploads";
import { UploadId } from "@x1agent/domain-uploads";

/**
 * Endpoints only the sidecar calls (same-cluster). Gated on a shared
 * secret header. The sidecar image receives the secret at deploy time
 * via the pod env; the api reads it from API_INTERNAL_TOKEN at boot.
 * Everything under /api/internal/* lives here.
 */
export interface InternalRoutesConfig {
  events: SessionEventRepository;
  sessions: SessionRepository;
  agents: AgentRepository;
  grants: PermissionGrantRepository;
  /**
   * Cost rollups exposed to the agent via the `/cost/*` internal
   * routes. Forwarded by the sidecar to the agent's MCP tools
   * (`get_session_cost`, `get_session_tree_cost`, `get_agent_cost`).
   * Optional only for symmetry with the rest of the config; in
   * practice the composition root always wires it.
   */
  tokenUsage?: TokenUsageRepository;
  githubClient: GitHubAppClient | null;
  internalToken: string;
  /**
   * Optional NATS connection used by the `/sessions/:id/message-caller`
   * route to publish a `message` wake into the parent orchestrator's
   * input subject. When absent, `message_caller` calls return 503
   * platform_wakes_disabled. Wired from the composition root.
   */
  natsConnection?: import("nats").NatsConnection;
  /**
   * Shared store for `expect_quiet_for` hints from children. The
   * watchdog consults the same store. When absent, the hint route
   * returns 503 and the watchdog runs without hint support.
   */
  quietHints?: import("../orchestration/quiet-hints.js").QuietHintStore;
  /**
   * Returns the set of admin-enabled Claude model ids, or null when
   * the deployment isn't curating (resolver not wired). When set, the
   * `/sessions/spawn` route rejects per-spawn `model` overrides that
   * aren't in it — closes the side-channel around the platform admin's
   * model gate at /admin/anthropic-models.
   *
   * X1A-40: same gate the agent-write path enforces on `agents.model`.
   */
  enabledModels?: () => Promise<Set<string> | null>;
  /**
   * X1A-96 → agent-side fetch. When set, exposes
   * `GET /api/internal/uploads/:id/raw` which streams the upload's
   * bytes back. The agent in a session pod has the `API_INTERNAL_TOKEN`
   * env var and can `curl` the route directly to read a file the user
   * attached to the prompt. Out-of-cluster traffic never sees this
   * route — Hono only mounts it under `/api/internal/*` which the
   * ingress doesn't expose externally.
   */
  uploads?: UploadRepository;
  uploadStorage?: UploadStorage;
  /**
   * Optional K8s Job terminator shared with the human-cancel path.
   * When wired, `cancel_session` from an orchestrator (X1A-118) also
   * deletes the child's K8s Job so the pod actually stops — without
   * this the cancel is purely a DB flip.
   */
  jobs?: JobTerminator;
  /**
   * In-cluster K8s client + namespace — needed by
   * `/sessions/:id/pull-for-parent` to exec `tar` in the child + parent
   * pods. When absent, the pull-from-child route returns 503.
   */
  kubeConfig?: KubeConfig;
  namespace?: string;
  /**
   * Raw SQL client — needed by `/sessions/:id/preview-deploy` to look
   * up the linked installation id directly on `agents`. When absent,
   * the preview-deploy route returns 503. Narrow escape hatch until
   * the agent-repo-store adapter exposes this as a first-class method.
   */
  sql?: import("postgres").Sql<Record<string, unknown>>;
  /**
   * Durable preview environment store. When present, the preview-deploy
   * route upserts a row at two points: status=provisioning before the
   * NATS request, status=ready|failed after the reply lands. The agent
   * sees the same response shape as before; the row is a side effect
   * the UI consumes through the workspace `/preview-environments` list.
   */
  previewEnvironments?: import("@x1agent/domain-preview-environments").PreviewEnvironmentRepository;
  /**
   * Workspace-scoped env-binding resolver — paired with the preview env's
   * `env_var_names` list, the preview-deploy route translates each name
   * into a (env_var, secret_value) pair and forwards them to the
   * provider as `extra_env`. Both deps must be wired for the lookup to
   * run; absent either, env vars set on the preview env are silently
   * ignored at deploy time.
   */
  workspaceBindings?: import("@x1agent/domain-agent-env").WorkspaceBindingRepository;
  workspaceSecrets?: import("@x1agent/domain-workspace-secrets").SecretService;
  /**
   * User-scoped OAuth token substrate. When present, exposes
   * looks up the user's stored grant for a provider, refreshes the
   * access token if it's near expiry, returns a fresh access_token.
   * Composition root wires this only when downstream-API providers
   * (Google Workspace, Microsoft 365, …) are part of the install.
   *
   * `refreshers` map provider id → refresher. v1 has just "google";
   * adding Microsoft 365 means adding a "microsoft-365" entry — no
   * route changes.
   */
  userOAuthTokens?: {
    store: import("@x1agent/domain-auth").UserOAuthTokenStore;
    encrypt: (plaintext: string) => import("@x1agent/domain-auth").EncryptedToken;
    decrypt: (
      blob: import("@x1agent/domain-auth").EncryptedToken,
    ) => string;
    refreshers: Record<
      string,
      {
        refreshAccessToken(refreshToken: string): Promise<{
          accessToken: string;
          expiresAt: Date | null;
        }>;
      }
    >;
  };
  /**
   * GCS bucket for share content. When set, the api re-uploads share
   * bytes from the local-dev fallback path (sidecar without GCS env)
   * straight to GCS, so legacy session pods still produce durable
   * shares. Empty = local-disk fallback (`/tmp/x1-shares`), wiped on
   * every api restart.
   */
  gcsArtifactsBucket?: string;
}

/**
 * Resolve a per-spawn `model` request against the admin-enabled
 * allowlist (X1A-40).
 *
 * Accepts two shapes:
 *   1. A short name — "sonnet" / "opus" / "haiku" (case-insensitive).
 *      We pick the first enabled model id whose base name (the part
 *      before any "@" version tag) matches, preferring GA over
 *      "@default" preview aliases.
 *   2. A full model id — "claude-sonnet-4-5@20250929" or whatever
 *      the upstream catalog returned. We accept it iff it appears
 *      verbatim in the enabled set.
 *
 * Returns null on any of: short name with no match, full id not in
 * the set, an enabled set that's the empty set (admin curated to
 * "nothing enabled"). When `enabled` is itself null — i.e. no
 * resolver wired, typically in tests — we accept any non-empty
 * string verbatim so the test surface still works.
 */
export function resolveSpawnModel(
  raw: string,
  enabled: Set<string> | null,
): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (enabled === null) {
    // Resolver not wired — accept short names as-is so tests don't
    // need an allowlist mock. Production composition wires
    // listEnabledOverrides; this branch should not run there.
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  const isShortName = /^(sonnet|opus|haiku)$/.test(lower);
  if (isShortName) {
    // Prefer a GA id (date-versioned) over an "@default" alias.
    const candidates = Array.from(enabled).filter((id) => {
      const base = id.split("@")[0]?.toLowerCase() ?? "";
      return base.includes(lower);
    });
    if (candidates.length === 0) return null;
    const ga = candidates.filter((id) => !id.endsWith("@default"));
    const pool = ga.length > 0 ? ga : candidates;
    // Newest first by string sort on the version tag (yyyymmdd).
    pool.sort((a, b) => b.localeCompare(a));
    return pool[0] ?? null;
  }
  return enabled.has(trimmed) ? trimmed : null;
}

/**
 * Map from a narrow Google OAuth scope → the set of broader scopes
 * that, in Google's hierarchy, fully cover it. The intent is that
 * a user who granted the broader scope should not be told their
 * permission is insufficient when a provider asks for a narrower
 * variant. The provider could ask for the broader scope directly,
 * but the conventional ask is "the least permission I need" — so the
 * platform meets it where it is.
 *
 * Only Google scopes need this today because Google ships the
 * fan-out of `.readonly`, `.metadata.readonly`, etc. as separate
 * strings; other providers either don't fan out or are listed once
 * verbatim already. Extend per provider when the same problem shows
 * up elsewhere.
 *
 * Sourced from Google's published OAuth scope docs:
 *   https://developers.google.com/identity/protocols/oauth2/scopes
 */
const GOOGLE_SCOPE_IMPLICATIONS: Record<string, readonly string[]> = {
  // Drive — full read+write covers every narrower drive.* variant.
  "https://www.googleapis.com/auth/drive.readonly": [
    "https://www.googleapis.com/auth/drive",
  ],
  "https://www.googleapis.com/auth/drive.metadata": [
    "https://www.googleapis.com/auth/drive",
  ],
  "https://www.googleapis.com/auth/drive.metadata.readonly": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.metadata",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  "https://www.googleapis.com/auth/drive.file": [
    "https://www.googleapis.com/auth/drive",
  ],
  // Sheets / Docs — read covered by full read+write.
  "https://www.googleapis.com/auth/spreadsheets.readonly": [
    "https://www.googleapis.com/auth/spreadsheets",
  ],
  "https://www.googleapis.com/auth/documents.readonly": [
    "https://www.googleapis.com/auth/documents",
  ],
  // Calendar — read variants covered by full calendar; events variants
  // similarly covered by the parent calendar scope.
  "https://www.googleapis.com/auth/calendar.readonly": [
    "https://www.googleapis.com/auth/calendar",
  ],
  "https://www.googleapis.com/auth/calendar.events": [
    "https://www.googleapis.com/auth/calendar",
  ],
  "https://www.googleapis.com/auth/calendar.events.readonly": [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
  // Gmail — gmail.modify is read + send + trash; gmail.readonly is
  // strictly read. Modify covers readonly; full mail covers both.
  "https://www.googleapis.com/auth/gmail.readonly": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
  ],
  "https://www.googleapis.com/auth/gmail.send": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
  ],
  "https://www.googleapis.com/auth/gmail.compose": [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
  ],
  "https://www.googleapis.com/auth/gmail.modify": [
    "https://mail.google.com/",
  ],
};

/**
 * Returns true when `requested` is either present in `granted` verbatim
 * or implied by some scope that is. Lets a user who consented to a
 * broader scope (`drive`) satisfy a provider asking for a narrower
 * variant (`drive.readonly`). For non-Google providers this collapses
 * to the original exact-match check since the implications table is
 * Google-only today.
 */
function scopeIsCovered(
  requested: string,
  granted: readonly string[],
): boolean {
  if (granted.includes(requested)) return true;
  const implicators = GOOGLE_SCOPE_IMPLICATIONS[requested];
  if (!implicators) return false;
  return implicators.some((s) => granted.includes(s));
}

/**
 * Resolve the recorded filename for a share when the caller didn't
 * pass `path`. Reads the `agent.share` event from session_events and
 * returns `payload.entry_point` (multi-file site) or `payload.path`
 * (single-file shorthand). Returns null when the share isn't in any
 * session's events — the caller will fall back to "index.html" and
 * the disk/GCS read will 404, which is the right shape for an
 * unknown share.
 */
async function resolveShareDefaultFilename(
  cfg: InternalRoutesConfig,
  shareId: string,
): Promise<string | null> {
  if (!cfg.sql) return null;
  const rows = await cfg.sql<{ entry_point: string | null; path: string | null }[]>`
    SELECT
      (payload->>'entry_point') AS entry_point,
      (payload->>'path')        AS path
    FROM session_events
    WHERE type = 'agent.share'
      AND (payload->>'share_id') = ${shareId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const candidate = row.entry_point ?? row.path;
  if (!candidate || candidate.length === 0) return null;
  return candidate;
}

function requireInternalToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      return c.json({ error: "internal_disabled" }, 503);
    }
    const header = c.req.header("x-internal-token");
    if (header !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

export function createInternalRoutes(cfg: InternalRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", requireInternalToken(cfg.internalToken));

  // Append a wire event from NATS / sidecar into durable storage.
  app.post("/sessions/:sessionId/events", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      seq?: number;
      type?: string;
      payload?: unknown;
      timestamp?: string;
    };
    if (
      typeof body.seq !== "number" ||
      typeof body.type !== "string"
    ) {
      return c.json({ error: "missing_fields" }, 400);
    }
    const row = await appendSessionEvent(
      { events: cfg.events },
      {
        sessionId: c.req.param("sessionId")! as SessionId,
        seq: body.seq,
        type: body.type,
        payload: body.payload ?? {},
        timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
      },
    );
    return c.json({ ok: true, duplicate: row === null });
  });

  // Spawn a child session on behalf of an orchestrator. The sidecar
  // passes the orchestrator's own session_id (known to it from pod env)
  // and the requested child agent id. The api enforces the spawn grant
  // and sets parent_session_id / parent_agent_id on the child row.
  app.post("/sessions/spawn", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      parent_session_id?: string;
      child_agent_id?: string;
      model?: string | null;
    };
    if (!body.parent_session_id || !body.child_agent_id) {
      return c.json(
        { error: "missing_fields", need: ["parent_session_id", "child_agent_id"] },
        400,
      );
    }

    // X1A-40: optional per-spawn Claude model override. Short names
    // ("sonnet" / "opus" / "haiku") resolve against the admin-curated
    // enabled set; full ids (e.g. "claude-sonnet-4-5@20250929") pass
    // through. Same allowlist enforced on agent.model — without this
    // re-check the spawn path is a side-channel around the platform
    // admin's model gate.
    let modelOverride: string | null = null;
    if (
      body.model !== undefined &&
      body.model !== null &&
      typeof body.model === "string" &&
      body.model.trim() !== ""
    ) {
      const enabled = cfg.enabledModels
        ? await cfg.enabledModels()
        : null;
      const resolved = resolveSpawnModel(body.model, enabled);
      if (!resolved) {
        return c.json(
          {
            error: "model_not_enabled",
            message:
              "The requested Claude model is not enabled for this deployment. Ask a platform admin to enable it at /admin/anthropic-models, or pass a model id that appears in the enabled list.",
            requested: body.model,
          },
          403,
        );
      }
      modelOverride = resolved;
    }

    const permission = {
      canSpawn: async (parentAgentId: ReturnType<typeof AgentId>, childAgentId: ReturnType<typeof AgentId>) => {
        // The parent agent's workspace owns the grants — we need to look
        // it up once before checking. Cheap: agents are cached by the
        // repo.
        const parentAgent = await cfg.agents.findById(parentAgentId);
        if (!parentAgent) return false;
        const grant = await findActiveGrant(
          { grants: cfg.grants },
          {
            workspaceId: parentAgent.workspaceId,
            subject: { kind: "agent", agentId: parentAgentId },
            grantType: SPAWN_GRANT_TYPE as never,
            matches: (d) => d["child_agent_id"] === childAgentId,
          },
        );
        return grant !== null;
      },
    };

    try {
      const child = await spawnChildSession(
        {
          agents: cfg.agents,
          sessions: cfg.sessions,
          permission,
          clock: systemClock,
        },
        {
          parentSessionId: body.parent_session_id as never,
          childAgentId: AgentId(body.child_agent_id),
          modelOverride,
        },
      );
      return c.json(
        {
          session: {
            id: child.id,
            agent_id: child.agentId,
            parent_session_id: child.parentSessionId,
            parent_agent_id: child.parentAgentId,
            triggered_by: child.triggeredBy,
            status: child.status,
            triggered_at: child.triggeredAt.toISOString(),
          },
        },
        201,
      );
    } catch (err) {
      if (err instanceof DomainError) {
        const status =
          err.code === "session_not_found" ||
          err.code === "agent_not_found"
            ? 404
            : err.code === "permission_required"
              ? 403
              : 400;
        return c.json(
          { error: err.code, message: err.message },
          status as 400,
        );
      }
      // Unknown error — bubble to app.onError → Sentry.
      throw err;
    }
  });

  // Read durable events from a child session. Authorization: the
  // caller passes parent_session_id in the query; the api verifies the
  // child was actually spawned by that parent before returning any
  // events. A sibling or ancestor session cannot read another's output.
  app.get("/sessions/:childId/child-events", async (c) => {
    const childId = c.req.param("childId")! as SessionId;
    const parentSessionId = c.req.query("parent_session_id");
    if (!parentSessionId)
      return c.json({ error: "missing_parent_session_id" }, 400);

    const child = await cfg.sessions.findById(childId);
    if (!child) return c.json({ error: "session_not_found" }, 404);
    if (child.parentSessionId !== parentSessionId)
      return c.json({ error: "not_your_child" }, 403);

    const afterRaw = c.req.query("after_seq");
    const limitRaw = c.req.query("limit");
    const limit = Math.max(
      1,
      Math.min(5000, limitRaw !== undefined ? Number(limitRaw) : 500),
    );
    const events = await cfg.events.listBySession(childId, {
      afterSeq: afterRaw !== undefined ? Number(afterRaw) : undefined,
      limit,
    });
    return c.json({
      child: {
        id: child.id,
        status: child.status,
      },
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        timestamp: e.timestamp.toISOString(),
      })),
    });
  });

  // List the child agents a given session is allowed to spawn. Derived
  // from permission_grants by looking up active spawn grants held by
  // the session's agent; returned enriched with agent name + slug so the
  // orchestrator can pick one without another round trip.
  app.get("/sessions/:sessionId/spawnable", async (c) => {
    const sessionId = c.req.param("sessionId")! as SessionId;
    const session = await cfg.sessions.findById(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const parentAgent = await cfg.agents.findById(session.agentId);
    if (!parentAgent) return c.json({ error: "agent_not_found" }, 404);

    const grants = await cfg.grants.listActive({
      workspaceId: parentAgent.workspaceId,
      subject: { kind: "agent", agentId: parentAgent.id },
      grantType: SPAWN_GRANT_TYPE as never,
    });

    const childIds = grants
      .map((g) => g.details["child_agent_id"])
      .filter((v): v is string => typeof v === "string");
    const unique = Array.from(new Set(childIds));
    const children = await Promise.all(
      unique.map((id) => cfg.agents.findById(AgentId(id))),
    );
    const spawnable = children
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => ({ id: a.id, slug: a.slug, name: a.name }));

    return c.json({ spawnable });
  });

  // Receive share files from the sidecar. Local-dev-only — in
  // production the sidecar uploads straight to GCS and skips this
  // path. The session must exist; files are written under
  // X1_SHARES_DIR/sessions/{id}/shares/{share_id}/.
  //
  // Cross-session share_id ownership check: when an agent re-shares
  // with a share_id, the id MUST already belong to THIS session (i.e.
  // an earlier `agent.share` event in this session emitted it). A
  // foreign id would let a workspace-B agent collide with a workspace-A
  // share — comment routing keys on share_id globally and would
  // misroute. Fresh ids (no prior event anywhere) are always allowed.
  app.post("/sessions/:sessionId/shares", async (c) => {
    const sessionId = c.req.param("sessionId")! as SessionId;
    const session = await cfg.sessions.findById(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      share_id?: string;
      files?: { path: string; content: string }[];
    };
    if (!body.share_id || !Array.isArray(body.files)) {
      return c.json(
        { error: "missing_fields", need: ["share_id", "files"] },
        400,
      );
    }

    if (cfg.sql) {
      const rows = await cfg.sql<{ session_id: string }[]>`
        SELECT session_id
        FROM session_events
        WHERE type = 'agent.share'
          AND (payload->>'share_id') = ${body.share_id}
        LIMIT 1
      `;
      const existingOwner = rows[0]?.session_id;
      if (existingOwner && existingOwner !== sessionId) {
        // Updating an existing share id is allowed for any session in
        // the same workspace — that's how "update this share" works
        // across paused/resumed sessions and across explicitly-shared
        // artifacts inside the workspace. Cross-workspace remains
        // forbidden: share_id is globally unique and a workspace-B
        // session writing to a workspace-A share would clobber the
        // tenant boundary.
        const ownerSession = await cfg.sessions.findById(
          existingOwner as never,
        );
        const callerAgent = await cfg.agents.findById(session.agentId);
        const ownerAgent = ownerSession
          ? await cfg.agents.findById(ownerSession.agentId)
          : null;
        if (
          !ownerAgent ||
          !callerAgent ||
          ownerAgent.workspaceId !== callerAgent.workspaceId
        ) {
          return c.json(
            { error: "share_id_owned_by_other_workspace" },
            403,
          );
        }
      }
    }

    try {
      const totalSize = await writeShareFiles(body.share_id, body.files, {
        gcsArtifactsBucket: cfg.gcsArtifactsBucket,
      });
      return c.json({ ok: true, total_size: totalSize });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "share_write_failed";
      console.warn(
        `[shares] write failed share=${body.share_id.slice(0, 8)} session=${(sessionId as unknown as string).slice(0, 8)} code=${code}: ${(err as Error).message}`,
      );
      return c.json({ error: code, message: (err as Error).message }, 502);
    }
  });

  // Read a share's content back to its producing session (X1A-32).
  //
  // The sidecar's /read_share route forwards here in local-dev (no GCS).
  // The sidecar already authenticates with the internal token; we just
  // need to confirm the share belongs to the named session (same
  // cross-session guard as the workspace-scoped /:shareId/content route)
  // before reading the bytes off disk.
  //
  // Returns { share_id, path?, mime_type, size, content_b64 } on
  // success. Empty `?path=` falls back to `index.html` — matches
  // writeShareFiles for single-file shares.
  app.get("/sessions/:sessionId/shares/:shareId/content", async (c) => {
    const sessionId = c.req.param("sessionId")! as SessionId;
    const shareId = c.req.param("shareId")!;
    const requestedPath = c.req.query("path") ?? "";

    const session = await cfg.sessions.findById(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    // 5000 matches the workspace-scoped read route. Shares are sparse
    // relative to message events, so the cap is effectively unbounded
    // in practice.
    const events = await cfg.events.listBySession(sessionId, { limit: 5000 });
    const sharedHere = events.some((e) => {
      if (e.type !== "agent.share") return false;
      const payload =
        typeof e.payload === "string"
          ? (JSON.parse(e.payload) as Record<string, unknown>)
          : (e.payload as Record<string, unknown>);
      return payload?.share_id === shareId;
    });

    if (!sharedHere) {
      // The share lives in a different session. We used to require the
      // owner session to be in this session's resume chain, but in
      // practice users paste any share URL from elsewhere in the same
      // workspace ("can you keep iterating on this artifact?") and the
      // ancestor-only check made every cross-workspace-internal read
      // 403. The correct tenant boundary is workspace_id — workspace
      // isolation is the security guarantee; cross-session within a
      // workspace is just internal-product UX.
      if (cfg.sql) {
        // Owner workspace is derived through agents — `sessions` itself
        // has no workspace_id column; workspace is pinned via the agent.
        const rows = await cfg.sql<{
          owner_workspace_id: string;
          caller_workspace_id: string;
        }[]>`
          WITH owner AS (
            SELECT s.id AS session_id, a.workspace_id
            FROM session_events se
            JOIN sessions s ON s.id = se.session_id
            JOIN agents   a ON a.id = s.agent_id
            WHERE se.type = 'agent.share'
              AND (se.payload->>'share_id') = ${shareId}
            LIMIT 1
          ),
          caller AS (
            SELECT a.workspace_id
            FROM sessions s
            JOIN agents   a ON a.id = s.agent_id
            WHERE s.id = ${sessionId}
            LIMIT 1
          )
          SELECT
            owner.workspace_id  AS owner_workspace_id,
            caller.workspace_id AS caller_workspace_id
          FROM owner CROSS JOIN caller
        `;
        const row = rows[0];
        if (!row) return c.json({ error: "share_not_found" }, 404);
        if (row.owner_workspace_id !== row.caller_workspace_id) {
          return c.json({ error: "cross_workspace_read_forbidden" }, 403);
        }
        // Owner is in the same workspace — allow the read to fall
        // through. (`resumeChainSessionIds` retained as a no-op import
        // in case other call sites still need ancestor-only semantics.)
      } else {
        return c.json({ error: "share_not_found" }, 404);
      }
    }

    // Resolve the actual filename when the caller didn't pass `path`.
    // The agent.share event in session_events IS the metadata record —
    // it carries `entry_point` (multi-file site) and `path` (single-
    // file shorthand). Without this, the code used to fall back to
    // `index.html` and 404 every single-file share (markdown, csv,
    // image, pdf), because the agent's read_share MCP tool doesn't
    // know the original filename and never passes a path. That's the
    // bug Fausto saw — bytes are in GCS, but `index.html` doesn't
    // exist for a single markdown file.
    const filePath =
      requestedPath ||
      (await resolveShareDefaultFilename(cfg, shareId)) ||
      "index.html";
    let bytes: Buffer | null;
    try {
      bytes = cfg.gcsArtifactsBucket
        ? await downloadShareFromGcs(cfg.gcsArtifactsBucket, shareId, filePath)
        : readShareFile(shareId, filePath);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "share_read_failed";
      return c.json({ error: code, message: (err as Error).message }, 502);
    }
    if (!bytes) return c.json({ error: "file_not_found" }, 404);
    return c.json({
      share_id: shareId,
      path: requestedPath || filePath,
      mime_type: getMimeType(filePath),
      size: bytes.length,
      content_b64: bytes.toString("base64"),
    });
  });

  // Orchestrator → child cancel. The parent's sidecar calls this when
  // the orchestrator invokes the `cancel_session` MCP tool (X1A-118).
  // Authorization is the parent → child relationship, not user RBAC:
  // the body carries the caller session_id and we refuse unless the
  // target child's parent_session_id matches it. Idempotent — a second
  // cancel on an already-terminal session returns `cancelled: false`.
  app.post("/sessions/:childId/cancel-by-parent", async (c) => {
    const childId = c.req.param("childId")! as SessionId;
    const body = (await c.req.json().catch(() => ({}))) as {
      parent_session_id?: string;
      reason?: string | null;
    };
    if (!body.parent_session_id) {
      return c.json(
        { error: "missing_fields", need: ["parent_session_id"] },
        400,
      );
    }
    try {
      const result = await cancelChildSession(
        {
          sessions: cfg.sessions,
          events: cfg.events,
          clock: systemClock,
          jobs: cfg.jobs,
        },
        body.parent_session_id as SessionId,
        childId,
        typeof body.reason === "string" ? body.reason : null,
      );
      return c.json({
        ok: true,
        cancelled: result.cancelled,
        session: {
          id: result.session.id,
          status: result.session.status,
          completed_at: result.session.completedAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      if (err instanceof NotYourChildError) {
        return c.json({ error: "not_your_child" }, 403);
      }
      if (err instanceof DomainError) {
        const status = err.code === "session_not_found" ? 404 : 400;
        return c.json(
          { error: err.code, message: err.message },
          status as 400,
        );
      }
      throw err;
    }
  });

  // Orchestrator → child snapshot transfer (X1A-63). The parent's
  // sidecar POSTs the file bytes here after validating the local
  // /workspace source path. We confirm parent → child, persist the
  // bytes to a per-stage directory on disk, then publish a NATS
  // message on the child's `.input` subject with kind=parent_staging
  // so the child's sidecar fetches and materializes the files into
  // `/workspace/{dest_path}`. Snapshot semantics — no subscription.
  app.post("/sessions/:childId/share-to-child", async (c) => {
    if (!cfg.natsConnection) {
      return c.json({ error: "parent_staging_unavailable" }, 503);
    }
    const childId = c.req.param("childId")! as SessionId;
    const body = (await c.req.json().catch(() => ({}))) as {
      parent_session_id?: string;
      dest_path?: string | null;
      files?: { path: string; content: string }[];
    };
    if (!body.parent_session_id || !Array.isArray(body.files)) {
      return c.json(
        {
          error: "missing_fields",
          need: ["parent_session_id", "files"],
        },
        400,
      );
    }
    if (body.files.length === 0) {
      return c.json({ error: "no_files" }, 400);
    }

    const child = await cfg.sessions.findById(childId);
    if (!child) return c.json({ error: "session_not_found" }, 404);
    if (child.parentSessionId !== body.parent_session_id) {
      return c.json({ error: "not_your_child" }, 403);
    }
    if (child.status === "complete" || child.status === "failed") {
      return c.json({ error: "child_not_live" }, 410);
    }

    const stageId = randomUUID();
    const result = writeStagingFiles(childId, stageId, body.files);

    // Resolve destination. When the parent named one, use it verbatim;
    // otherwise default to the first file's relative path. The sidecar
    // side enforces traversal safety again before writing to
    // /workspace, so a malformed dest_path can't escape the volume.
    const destPath =
      typeof body.dest_path === "string" && body.dest_path.trim() !== ""
        ? body.dest_path.trim()
        : (result.paths[0] ?? "");

    const sc = StringCodec();
    const envelope = {
      session_id: childId,
      timestamp: new Date().toISOString(),
      type: "user.message",
      payload: {
        // The text is what /inject sees; the sidecar suppresses the
        // /inject post on parent_staging events so this string never
        // reaches the SDK. It exists so an older sidecar that lacks
        // the staging branch falls back to a useful wake instead of
        // a cryptic empty inject.
        text: `Parent staged ${result.paths.length} file(s) at /workspace/${destPath}`,
        kind: "parent_staging",
        source: "platform",
        event_id: stageId,
        stage_id: stageId,
        dest_path: destPath,
        paths: result.paths,
        from_session_id: body.parent_session_id,
      },
    };
    cfg.natsConnection.publish(
      `x1.session.${childId}.input`,
      sc.encode(JSON.stringify(envelope)),
    );

    return c.json({
      ok: true,
      stage_id: stageId,
      dest_path: destPath,
      files: result.paths,
      total_size: result.totalSize,
    });
  });

  // Sidecar fetch of a single staged file (X1A-63). The child's
  // sidecar pulls each path out of staging into /workspace/{dest_path}
  // on receipt of the parent_staging NATS notification.
  app.get("/sessions/:sessionId/staging/:stageId/content", async (c) => {
    const sessionId = c.req.param("sessionId")! as SessionId;
    const stageId = c.req.param("stageId")!;
    const filePath = c.req.query("path") ?? "";
    if (!filePath) return c.json({ error: "missing_path" }, 400);
    const bytes = readStagingFile(sessionId, stageId, filePath);
    if (!bytes) return c.json({ error: "file_not_found" }, 404);
    return c.json({
      stage_id: stageId,
      path: filePath,
      mime_type: getMimeType(filePath),
      size: bytes.length,
      content_b64: bytes.toString("base64"),
    });
  });

  // Orchestrator → child workspace pull (inverse of share-to-child).
  // The parent's sidecar POSTs here when the orchestrator invokes
  // `pull_from_child`. We exec `tar` in both pods to snapshot the
  // child's /workspace into the parent's /workspace/workers/<child>/.
  // Worker-driven `share` was unreliable on small models (Haiku) which
  // narrate calling the tool but don't emit the structured call — the
  // orchestrator-pulls direction sidesteps that entirely.
  app.post("/sessions/:childId/pull-for-parent", async (c) => {
    if (!cfg.kubeConfig || !cfg.namespace) {
      return c.json({ error: "pull_unavailable", message: "k8s client not wired" }, 503);
    }
    const childId = c.req.param("childId")! as SessionId;
    const body = (await c.req.json().catch(() => ({}))) as {
      parent_session_id?: string;
      paths?: string[];
    };
    if (!body.parent_session_id || typeof body.parent_session_id !== "string") {
      return c.json({ error: "missing_fields", need: ["parent_session_id"] }, 400);
    }

    const child = await cfg.sessions.findById(childId);
    if (!child) return c.json({ error: "child_not_found" }, 404);
    if (child.parentSessionId !== body.parent_session_id) {
      return c.json({ error: "not_your_child" }, 403);
    }
    const parent = await cfg.sessions.findById(body.parent_session_id as SessionId);
    if (!parent || parent.status === "complete" || parent.status === "failed") {
      return c.json({ error: "parent_not_live" }, 410);
    }

    const startedAt = Date.now();
    try {
      const result = await pullFromChild({
        kubeConfig: cfg.kubeConfig,
        namespace: cfg.namespace,
        parentSessionId: body.parent_session_id,
        childSessionId: childId as unknown as string,
        paths: Array.isArray(body.paths) ? body.paths : undefined,
      });
      console.log(
        `[pull-for-parent] ok parent=${body.parent_session_id.slice(0, 8)} child=${childId.slice(0, 8)} files=${result.files} bytes=${result.totalBytes} elapsed=${Date.now() - startedAt}ms`,
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "pull_failed";
      const status =
        code === "child_workspace_unavailable" ? 410
          : code === "workspace_too_large" ? 413
          : code === "parent_pod_missing" ? 404
          : 502;
      console.warn(
        `[pull-for-parent] failed code=${code} parent=${body.parent_session_id.slice(0, 8)} child=${childId.slice(0, 8)} elapsed=${Date.now() - startedAt}ms: ${(err as Error).message}`,
      );
      return c.json(
        { error: code, message: (err as Error).message },
        status,
      );
    }
  });

  // Child → parent explicit signal. The child's sidecar calls this
  // when the child invokes the `message_caller` MCP tool. We look
  // up the child's parent, confirm the parent is alive + an
  // orchestrator, and publish a `message` wake to the parent's
  // input subject. See docs/architecture/orchestration.md §
  // Server-driven wakes.
  app.post("/sessions/:sessionId/message-caller", async (c) => {
    const sessionId = c.req.param("sessionId")! as SessionId;
    const body = (await c.req.json().catch(() => ({}))) as {
      summary?: string;
      body?: string | null;
      needs_response?: boolean;
    };
    if (!body.summary || typeof body.summary !== "string") {
      return c.json({ error: "missing_fields", need: ["summary"] }, 400);
    }
    if (!cfg.natsConnection) {
      return c.json({ error: "platform_wakes_disabled" }, 503);
    }

    const child = await cfg.sessions.findById(sessionId);
    if (!child) return c.json({ error: "session_not_found" }, 404);
    if (!child.parentSessionId) {
      return c.json({ error: "no_parent" }, 400);
    }
    const parent = await cfg.sessions.findById(child.parentSessionId);
    if (!parent || parent.status === "complete" || parent.status === "failed") {
      return c.json({ error: "parent_not_live" }, 410);
    }
    const parentAgent = await cfg.agents.findById(parent.agentId as never);
    if (!parentAgent || parentAgent.kind !== "orchestrator") {
      // Workers don't get platform wakes. Accept but no-op — the
      // child's call succeeded, just nothing to route.
      return c.json({ ok: true, delivered: false, reason: "parent_not_orchestrator" });
    }
    const childAgent = await cfg.agents.findById(child.agentId as never);
    const { publishMessageWake } = await import(
      "../orchestration/wake-publisher.js"
    );
    try {
      await publishMessageWake(cfg.natsConnection, parent.id, {
        childSessionId: child.id,
        childSlug: String(childAgent?.slug ?? "<unknown>"),
        summary: body.summary,
        body: typeof body.body === "string" ? body.body : null,
        needsResponse: body.needs_response === true,
      });
      return c.json({ ok: true, delivered: true });
    } catch (err) {
      return c.json(
        { error: "publish_failed", message: (err as Error).message },
        502,
      );
    }
  });

  // Child → watchdog "expect quiet for N seconds" hint. Called via
  // the child's MCP tool `expect_quiet_for`. The watchdog checks
  // the shared store before firing, so a child about to run a
  // 10-minute npm install or test suite doesn't get escalated as
  // if it were stuck. See docs/architecture/orchestration.md §
  // Server-driven wakes.
  app.post("/sessions/:sessionId/quiet-hint", async (c) => {
    if (!cfg.quietHints) {
      return c.json({ error: "quiet_hints_disabled" }, 503);
    }
    const sessionId = c.req.param("sessionId")!;
    const body = (await c.req.json().catch(() => ({}))) as {
      seconds?: number;
      reason?: string | null;
    };
    if (typeof body.seconds !== "number") {
      return c.json({ error: "missing_fields", need: ["seconds"] }, 400);
    }
    cfg.quietHints.record(
      sessionId,
      body.seconds,
      typeof body.reason === "string" ? body.reason : null,
    );
    return c.json({ ok: true });
  });

  // Agent → preview-provider. The sidecar forwards the agent's
  // preview_deploy MCP call here. We:
  //   1. Resolve the attached repo for the session's agent, pull the
  //      installation_id.
  //   2. Fetch .x1agent/preview.yaml at the requested sha via the
  //      GitHub API (using a freshly minted installation token).
  //   3. Fire a NATS request to the provider and relay the reply.
  //
  // Keeps the agent's MCP surface tiny: it names a repo + branch +
  // sha; the platform handles installation lookup, preview.yaml
  // retrieval, and provider routing.
  app.post("/sessions/:sessionId/preview-deploy", async (c) => {
    if (!cfg.natsConnection) {
      return c.json({ error: "preview_provider_unavailable" }, 503);
    }
    const sessionId = c.req.param("sessionId")! as SessionId;
    const body = (await c.req.json().catch(() => ({}))) as {
      repo_full_name?: string;
      branch?: string;
      commit_sha?: string;
    };
    if (!body.repo_full_name || !body.branch || !body.commit_sha) {
      return c.json(
        {
          error: "missing_fields",
          need: ["repo_full_name", "branch", "commit_sha"],
        },
        400,
      );
    }

    const session = await cfg.sessions.findById(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    if (!cfg.sql) {
      return c.json(
        { error: "preview_provider_unavailable", message: "sql not wired" },
        503,
      );
    }

    // Look up the attached installation for this session's agent. The
    // agent_repos linkage already provides it; we query directly here
    // rather than add a new port just for this path.
    const agent = await cfg.agents.findById(session.agentId as never);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);

    // Re-check that the requested repo is actually linked to this agent.
    // The installation token granted below covers every repo the GitHub
    // App installation can see — not just the ones this agent was
    // explicitly granted. Trusting body.repo_full_name verbatim would
    // let an agent with a single linked repo build any other repo in
    // the same installation (source exfiltration + cross-repo deploy).
    const repoLinked = await cfg.sql<{ ok: boolean }[]>`
      SELECT TRUE AS ok FROM agent_repos
      WHERE agent_id = ${session.agentId}
        AND repo_full_name = ${body.repo_full_name}
      LIMIT 1`;
    if (repoLinked.length === 0) {
      return c.json(
        {
          error: "repo_not_linked",
          message: `Repo ${body.repo_full_name} is not linked to this agent.`,
        },
        403,
      );
    }

    const linkedRows = await cfg.sql<
      { installation_id: string | null }[]
    >`SELECT linked_installation_id AS installation_id FROM agents WHERE id = ${session.agentId}`;
    const installationIdStr = linkedRows[0]?.installation_id;
    if (!installationIdStr) {
      return c.json(
        {
          error: "no_installation",
          message:
            "Agent has no linked GitHub installation — attach a repo first.",
        },
        400,
      );
    }
    const installationId = Number(installationIdStr);

    // Fetch preview.yaml at the requested sha. Mint a token directly
    // rather than going through a second HTTP hop to ourselves; the
    // logic is the same as the git-credential route.
    const tokenRes = await fetch(
      `http://localhost:${process.env.API_PORT ?? "30001"}/api/internal/git-credential?installation_id=${installationId}`,
      { headers: { "X-Internal-Token": cfg.internalToken } },
    );
    if (!tokenRes.ok) {
      return c.json(
        { error: "token_mint_failed", message: `status ${tokenRes.status}` },
        502,
      );
    }
    const { token } = (await tokenRes.json()) as {
      username: string;
      token: string;
    };

    const ghRes = await fetch(
      `https://api.github.com/repos/${body.repo_full_name}/contents/.x1agent/preview.yaml?ref=${encodeURIComponent(body.commit_sha)}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.raw",
        },
      },
    );
    if (!ghRes.ok) {
      return c.json(
        {
          error: "preview_yaml_missing",
          message: `GitHub returned ${ghRes.status} for ${body.repo_full_name}@${body.commit_sha}:.x1agent/preview.yaml`,
        },
        ghRes.status === 404 ? 400 : 502,
      );
    }
    const previewYaml = await ghRes.text();

    // Extract metadata.name from the yaml for an immediate "I'm
    // provisioning" upsert before the long-running NATS request. The
    // provider does the full schema validation; we only need the slug
    // here so the workspace UI can render a row right away. Regex
    // tolerates quoted and unquoted forms; falls back to no-early-row
    // when the shape doesn't match (provider's parse will fail with a
    // crisp message either way).
    const slugMatch = previewYaml.match(
      /(^|\n)metadata:\s*\n\s+name:\s*['"]?([a-z][a-z0-9-]{0,62})['"]?\s*(\n|$)/,
    );
    const earlySlug = slugMatch?.[2];
    if (cfg.previewEnvironments && earlySlug) {
      try {
        const { upsertPreviewEnvironment } = await import(
          "@x1agent/domain-preview-environments"
        );
        await upsertPreviewEnvironment(
          { repository: cfg.previewEnvironments },
          {
            workspaceId: agent.workspaceId,
            slug: earlySlug,
            repoFullName: body.repo_full_name,
            branch: body.branch,
            deploy: { status: "provisioning" },
          },
        );
      } catch (earlyErr) {
        // Non-fatal — operator just won't see the row until the deploy
        // resolves. If this fires for a slug-taken conflict, the
        // provider's reply will surface the same error to the agent.
        console.warn(
          "[preview-deploy] early upsert failed:",
          (earlyErr as Error).message,
        );
      }
    }

    // Resolve workspace-scoped env bindings the preview opted into.
    // The preview's env_var_names list (set in the workspace UI) names
    // env_bindings rows with scope='workspace'; each row references a
    // workspace_secret. We turn the list into a {ENV_NAME → plaintext}
    // map here so the provider can mint the per-preview K8s Secret
    // without needing direct DB or secret-store access.
    //
    // Best-effort: missing bindings or secrets are silently skipped —
    // the agent's app sees that env var as unset rather than crashing
    // the deploy. Logged so the operator can spot misconfigurations.
    const extraEnv: Record<string, string> = {};
    // Custom hostnames the preview answers on, beyond `<slug>.<preview-domain>`.
    // Operator-curated list on the preview_environments row; pulled here
    // so the provider can emit alias TLS + Ingress rules on this deploy.
    let aliasHosts: readonly string[] = [];
    if (
      cfg.previewEnvironments &&
      cfg.workspaceBindings &&
      cfg.workspaceSecrets &&
      earlySlug
    ) {
      try {
        const existingEnv = await cfg.previewEnvironments.findBySlug(
          agent.workspaceId,
          earlySlug as never,
        );
        aliasHosts = existingEnv?.aliasHosts ?? [];
        const names = existingEnv?.envVarNames ?? [];
        if (names.length > 0) {
          const bindings = await cfg.workspaceBindings.findByNames(
            agent.workspaceId as string,
            names,
          );
          for (const binding of bindings) {
            const value = await cfg.workspaceSecrets.resolve(
              agent.workspaceId as string,
              binding.secretName,
            );
            if (value !== null) {
              extraEnv[binding.envName as string] = value;
            } else {
              console.warn(
                `[preview-deploy] workspace secret '${binding.secretName}' (bound to env '${binding.envName}') resolved null — skipping`,
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          "[preview-deploy] env-binding resolver failed:",
          (err as Error).message,
        );
      }
    }

    // NATS request/reply to the provider. Timeout covers a full
    // Kaniko build + Deployment ready — hence 20 minutes.
    const jc = JSONCodec();
    const sc = StringCodec();
    void sc;
    try {
      const reply = await cfg.natsConnection.request(
        "x1.provider.preview.provision",
        jc.encode({
          preview_yaml: previewYaml,
          repo_full_name: body.repo_full_name,
          branch: body.branch,
          commit_sha: body.commit_sha,
          installation_id: installationId,
          extra_env: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
          alias_hosts: aliasHosts.length > 0 ? aliasHosts : undefined,
        }),
        { timeout: 20 * 60 * 1000 },
      );
      const result = jc.decode(reply.data) as
        | { ok: true; url: string; slug: string; image: string; job_name: string }
        | { ok: false; code: string; message: string };

      // Side-effect: upsert the durable preview environment row so the
      // workspace UI's Environments list reflects this deploy. We only
      // fire this when the repository is wired in composition; older
      // installs without it keep the old "URL returned, nothing
      // persisted" shape and get a UI list once they upgrade.
      if (cfg.previewEnvironments) {
        try {
          const { upsertPreviewEnvironment } = await import(
            "@x1agent/domain-preview-environments"
          );
          if (result.ok) {
            await upsertPreviewEnvironment(
              { repository: cfg.previewEnvironments },
              {
                workspaceId: agent.workspaceId,
                slug: result.slug,
                repoFullName: body.repo_full_name,
                branch: body.branch,
                deploy: {
                  status: "ready",
                  sha: body.commit_sha,
                  url: result.url,
                  imageRef: result.image,
                },
              },
            );
          } else {
            // Failure path. Prefer the slug from the provider's reply
            // (set when the parse succeeded but a later step failed);
            // fall back to the earlySlug we grabbed before the NATS
            // request so the in-progress row doesn't sit at
            // status=provisioning forever after an invalid_preview_spec.
            const failed = result as
              & { ok: false; code: string; message: string }
              & { slug?: string };
            const slug = failed.slug ?? earlySlug;
            if (slug) {
              await upsertPreviewEnvironment(
                { repository: cfg.previewEnvironments },
                {
                  workspaceId: agent.workspaceId,
                  slug,
                  repoFullName: body.repo_full_name,
                  branch: body.branch,
                  deploy: {
                    status: "failed",
                    sha: body.commit_sha,
                    statusReason: result.message,
                  },
                },
              );
            }
          }
        } catch (upsertErr) {
          // Persistence of the side-effect must not block the agent's
          // response. Log + swallow.
          console.warn(
            "[preview-deploy] upsert failed:",
            (upsertErr as Error).message,
          );
        }
      }

      if (!result.ok) {
        const status =
          result.code === "invalid_preview_spec" ? 400 : 502;
        return c.json(result, status);
      }
      return c.json(result);
    } catch (err) {
      // NATS timeout / broker disconnect / provider crash mid-build all
      // land here. Without this branch the early provisioning row sits
      // at status='provisioning' forever and the UI spins. Stamp it
      // failed so the operator sees what happened and can re-deploy.
      if (cfg.previewEnvironments && earlySlug) {
        try {
          const { upsertPreviewEnvironment } = await import(
            "@x1agent/domain-preview-environments"
          );
          await upsertPreviewEnvironment(
            { repository: cfg.previewEnvironments },
            {
              workspaceId: agent.workspaceId,
              slug: earlySlug,
              repoFullName: body.repo_full_name,
              branch: body.branch,
              deploy: {
                status: "failed",
                sha: body.commit_sha,
                statusReason: `provider_request_failed: ${(err as Error).message}`,
              },
            },
          );
        } catch (upsertErr) {
          console.warn(
            "[preview-deploy] failure upsert in catch:",
            (upsertErr as Error).message,
          );
        }
      }
      return c.json(
        {
          error: "provider_request_failed",
          message: (err as Error).message,
        },
        504,
      );
    }
  });

  // Mint a fresh user-OAuth access token for a (user, provider) pair.
  // before forwarding any provider→external-API call. Refreshes the
  // access token transparently when expired; returns 403
  // permission_required when the user hasn't granted the requested
  // scope or the refresh token is missing/revoked.
  //
  // Query params: user_id (required), provider (required, e.g.
  // "google"), scope (optional — when set, the granted scopes must
  // include it; the platform-required identity scopes like email/
  // profile are NOT required to be in the query — caller asks only
  // for the downstream-API scope it actually needs).
  //
  // Returns: { access_token, expires_at: ISO8601 | null }.
  app.get("/user-oauth-token", async (c) => {
    if (!cfg.userOAuthTokens) {
      return c.json({ error: "user_oauth_disabled" }, 503);
    }
    const userId = c.req.query("user_id");
    const provider = c.req.query("provider");
    const scope = c.req.query("scope");
    if (!userId || !provider) {
      return c.json(
        { error: "missing_param", message: "user_id and provider required" },
        400,
      );
    }

    const blob = await cfg.userOAuthTokens.store.loadEncryptedTokens(
      userId,
      provider,
    );
    if (!blob) {
      return c.json(
        {
          error: "permission_required",
          message: `user has no ${provider} grant`,
        },
        403,
      );
    }

    if (scope && !scopeIsCovered(scope, blob.scopesGranted)) {
      return c.json(
        {
          error: "permission_required",
          message: `scope not granted: ${scope}`,
          granted: blob.scopesGranted,
        },
        403,
      );
    }

    // 30s buffer — refresh if the access token is at-or-near expiry.
    // The provider's clock and ours can drift slightly; a buffer
    // saves a wasted upstream 401 round-trip.
    const expiresAt = blob.expiresAt;
    const needsRefresh =
      expiresAt !== null && expiresAt.getTime() < Date.now() + 30_000;

    if (!needsRefresh) {
      try {
        const accessToken = cfg.userOAuthTokens.decrypt(blob.accessToken);
        return c.json({
          access_token: accessToken,
          expires_at: expiresAt ? expiresAt.toISOString() : null,
        });
      } catch (err) {
        return c.json(
          { error: "decrypt_failed", message: (err as Error).message },
          500,
        );
      }
    }

    const refresher = cfg.userOAuthTokens.refreshers[provider];
    if (!refresher) {
      return c.json(
        {
          error: "refresh_unavailable",
          message: `no refresher wired for provider ${provider}`,
        },
        503,
      );
    }
    if (!blob.refreshToken) {
      return c.json(
        {
          error: "permission_required",
          message:
            "access token expired and no refresh token; user must re-authenticate",
        },
        403,
      );
    }

    let refreshTokenPlain: string;
    try {
      refreshTokenPlain = cfg.userOAuthTokens.decrypt(blob.refreshToken);
    } catch (err) {
      return c.json(
        { error: "decrypt_failed", message: (err as Error).message },
        500,
      );
    }

    let refreshed: { accessToken: string; expiresAt: Date | null };
    try {
      refreshed = await refresher.refreshAccessToken(refreshTokenPlain);
    } catch (err) {
      return c.json(
        {
          error: "permission_required",
          message: `refresh failed: ${(err as Error).message}`,
        },
        403,
      );
    }

    // Persist the new access token. Refresh token usually doesn't
    // rotate, but if the provider returned a new one we'd handle
    // that in the refresher (today neither Google nor Microsoft
    // rotate refresh on every refresh).
    const newEncrypted = cfg.userOAuthTokens.encrypt(refreshed.accessToken);
    try {
      await cfg.userOAuthTokens.store.updateAccessToken(
        userId,
        provider,
        newEncrypted,
        refreshed.expiresAt,
      );
    } catch (err) {
      // Persist failed but the user still has a working token for
      // this call. Log + continue — next call will refresh again,
      // worst case is one extra round-trip.
      console.warn(
        `[user-oauth-token] persist refreshed access_token failed: ${(err as Error).message}`,
      );
    }

    return c.json({
      access_token: refreshed.accessToken,
      expires_at: refreshed.expiresAt
        ? refreshed.expiresAt.toISOString()
        : null,
    });
  });

  // Mint a short-lived GitHub App installation token for the sidecar.
  // Returns it in git's credential-helper shape: (username, token).
  app.get("/git-credential", async (c) => {
    const idRaw = c.req.query("installation_id");
    if (!idRaw) return c.json({ error: "missing_installation_id" }, 400);
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "bad_installation_id" }, 400);
    }
    if (!cfg.githubClient) {
      return c.json({ error: "github_not_configured" }, 503);
    }
    try {
      const minted = await cfg.githubClient.mintInstallationToken(
        id as InstallationId,
      );
      return c.json({
        username: "x-access-token",
        token: minted.token,
        expires_at: minted.expiresAt.toISOString(),
      });
    } catch (err) {
      return c.json(
        {
          error: "mint_failed",
          message: (err as Error).message,
        },
        502,
      );
    }
  });

  // ── Cost surfacing (X1A-37). Internal routes the sidecar forwards
  // the agent's MCP tools to. The agent never sees workspace_id —
  // we resolve it from session_id here so the tool surface is
  // "what's MY cost right now" with no cross-tenant arguments.

  // GET /sessions/:sessionId/cost — sidecar forwards from /cost/session.
  app.get("/sessions/:sessionId/cost", async (c) => {
    if (!cfg.tokenUsage) return c.json({ error: "cost_disabled" }, 503);
    const sessionId = c.req.param("sessionId")!;
    const session = await cfg.sessions.findById(sessionId as never);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const agent = await cfg.agents.findById(session.agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    const rollup = await cfg.tokenUsage.rollupForSession({
      sessionId,
      workspaceId: agent.workspaceId,
    });
    return c.json(rollup);
  });

  // GET /sessions/:sessionId/cost-tree — sidecar forwards from
  // /cost/session-tree.
  app.get("/sessions/:sessionId/cost-tree", async (c) => {
    if (!cfg.tokenUsage) return c.json({ error: "cost_disabled" }, 503);
    const sessionId = c.req.param("sessionId")!;
    const session = await cfg.sessions.findById(sessionId as never);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const agent = await cfg.agents.findById(session.agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    const rollup = await cfg.tokenUsage.rollupForSessionTree({
      sessionId,
      workspaceId: agent.workspaceId,
    });
    return c.json(rollup);
  });

  // GET /sessions/:sessionId/agent-cost?window=24h|7d|30d|all —
  // resolves agent_id + workspace_id from the session so the agent's
  // MCP tool can self-roll-up without ever naming a workspace.
  // Sidecar forwards from /cost/agent.
  app.get("/sessions/:sessionId/agent-cost", async (c) => {
    if (!cfg.tokenUsage) return c.json({ error: "cost_disabled" }, 503);
    const sessionId = c.req.param("sessionId")!;
    const session = await cfg.sessions.findById(sessionId as never);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const agent = await cfg.agents.findById(session.agentId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    const windowRaw = c.req.query("window") ?? "7d";
    const ok: readonly AgentCostWindow[] = ["24h", "7d", "30d", "all"];
    const window = (ok as readonly string[]).includes(windowRaw)
      ? (windowRaw as AgentCostWindow)
      : "7d";
    const rollup = await cfg.tokenUsage.rollupForAgent({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      window,
      now: new Date(),
    });
    return c.json(rollup);
  });

  // X1A-96 → upload-bytes fetch. After the t02/t05 P0 fix, the agent
  // container does NOT have API_INTERNAL_TOKEN and cannot reach this
  // route directly. The sidecar (which IS the trust boundary) holds
  // the master token and exposes an `/uploads/read` HTTP route the
  // agent process calls; that route in turn calls this endpoint with
  // the sidecar's pod-env user_id + session_id, exactly the same
  // shape as /git-credential and /user-oauth-token.
  //
  // We additionally surface the upload's owning workspace slug back
  // to the sidecar via the `X-Upload-Workspace-Slug` response header
  // so the sidecar can apply a workspace-match defense-in-depth check
  // (its own SESSION_WORKSPACE_SLUG env vs. the upload's). When the
  // upload has no bound session yet (session_id null), the header is
  // omitted and the sidecar relies on the user_id check below.
  app.get("/uploads/:id/raw", async (c) => {
    if (!cfg.uploads || !cfg.uploadStorage) {
      return c.json({ error: "uploads_disabled" }, 503);
    }
    let id;
    try {
      id = UploadId(c.req.param("id"));
    } catch {
      return c.json({ error: "invalid_id" }, 400);
    }
    // Ownership check (X1A-96 security boundary). The internal token
    // alone proves "this caller is the sidecar"; it doesn't prove
    // "this caller's session is allowed to read this upload." Without
    // the user_id check, a compromised sidecar (or a future caller
    // we add) in session A could fetch any upload id it learned of
    // — including ones attached to a different user's session. We
    // require the caller to name the user_id they're acting as, and
    // refuse if the upload row's creator doesn't match. 404 (not 403)
    // so the route never leaks the existence of someone else's
    // upload.
    //
    // For an extra belt: when the upload row has a session_id set,
    // we also require the caller's session_id to match (so the same
    // user's other sessions can't trivially read uploads attached
    // elsewhere). Unattached uploads (session_id null) skip that
    // check since they haven't been bound yet.
    const callerUserId = c.req.query("user_id");
    const callerSessionId = c.req.query("session_id");
    if (!callerUserId) {
      return c.json({ error: "user_id_required" }, 400);
    }
    const upload = await cfg.uploads.findById(id);
    if (!upload) return c.json({ error: "not_found" }, 404);
    if (upload.userId !== callerUserId) {
      return c.json({ error: "not_found" }, 404);
    }
    if (
      upload.sessionId !== null &&
      callerSessionId &&
      upload.sessionId !== callerSessionId
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    if (upload.status !== "ready" && upload.status !== "attached") {
      return c.json({ error: "upload_not_ready" }, 409);
    }

    // Resolve the upload's owning workspace slug for the sidecar's
    // defense-in-depth workspace check. Only meaningful when the
    // upload has a bound session — otherwise no workspace has
    // "claimed" it and the user_id check above is the boundary.
    let workspaceSlug: string | null = null;
    if (upload.sessionId !== null) {
      try {
        const session = await cfg.sessions.findById(upload.sessionId as never);
        if (session) {
          const agent = await cfg.agents.findById(session.agentId);
          if (agent && cfg.sql) {
            const rows = await cfg.sql<{ slug: string }[]>`
              SELECT slug FROM workspaces WHERE id = ${agent.workspaceId} LIMIT 1
            `;
            workspaceSlug = rows[0]?.slug ?? null;
          }
        }
      } catch (err) {
        // Defense-in-depth header — failure to resolve is non-fatal,
        // the sidecar will just skip its workspace check. Log so the
        // operator notices a recurring lookup miss.
        console.warn(
          `[uploads/raw] workspace-slug lookup failed for upload ${id}: ${(err as Error).message}`,
        );
      }
    }

    const body = await cfg.uploadStorage.readObject(upload.storageKey);
    const headers: Record<string, string> = {
      "Content-Type": upload.mime,
      "Content-Length": String(upload.sizeBytes),
      "Cache-Control": "private, no-store",
    };
    if (workspaceSlug) {
      headers["X-Upload-Workspace-Slug"] = workspaceSlug;
    }
    return new Response(body as BodyInit, { status: 200, headers });
  });

  return app;
}
