import { Hono, type MiddlewareHandler } from "hono";
import { DomainError, systemClock } from "@x1agent/kernel";
import type { GitHubAppClient, InstallationId } from "@x1agent/domain-github";
import { AgentId, type AgentRepository } from "@x1agent/domain-agents";
import type {
  AgentCostWindow,
  SessionEventRepository,
  SessionRepository,
  TokenUsageRepository,
} from "@x1agent/domain-sessions";
import {
  SessionId,
  appendSessionEvent,
  spawnChildSession,
} from "@x1agent/domain-sessions";
import {
  SPAWN_GRANT_TYPE,
  findActiveGrant,
  type PermissionGrantRepository,
} from "@x1agent/domain-permissions";
import { writeShareFiles } from "../shares/storage.js";
import { StringCodec, JSONCodec } from "nats";

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
   * Raw SQL client — needed by `/sessions/:id/preview-deploy` to look
   * up the linked installation id directly on `agents`. When absent,
   * the preview-deploy route returns 503. Narrow escape hatch until
   * the agent-repo-store adapter exposes this as a first-class method.
   */
  sql?: import("postgres").Sql<Record<string, unknown>>;
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
        return c.json(
          { error: "share_id_owned_by_other_session" },
          403,
        );
      }
    }

    const totalSize = writeShareFiles(sessionId, body.share_id, body.files);
    return c.json({ ok: true, total_size: totalSize });
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

    // NATS request/reply to the provider. Timeout covers a full
    // Kaniko build + Deployment ready — hence 20 minutes.
    const jc = JSONCodec();
    const sc = StringCodec();
    void sc;
    try {
      const reply = await cfg.natsConnection.request(
        "x1.providers.preview.provision",
        jc.encode({
          preview_yaml: previewYaml,
          repo_full_name: body.repo_full_name,
          branch: body.branch,
          commit_sha: body.commit_sha,
          installation_id: installationId,
        }),
        { timeout: 20 * 60 * 1000 },
      );
      const result = jc.decode(reply.data) as
        | { ok: true; url: string; slug: string; image: string; job_name: string }
        | { ok: false; code: string; message: string };
      if (!result.ok) {
        const status =
          result.code === "invalid_preview_spec" ? 400 : 502;
        return c.json(result, status);
      }
      return c.json(result);
    } catch (err) {
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

    if (scope && !blob.scopesGranted.includes(scope)) {
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

  return app;
}
