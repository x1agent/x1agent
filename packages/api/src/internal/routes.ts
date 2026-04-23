import { Hono, type MiddlewareHandler } from "hono";
import { DomainError, systemClock } from "@x1agent/kernel";
import type { GitHubAppClient, InstallationId } from "@x1agent/domain-github";
import { AgentId, type AgentRepository } from "@x1agent/domain-agents";
import type {
  SessionEventRepository,
  SessionRepository,
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
    };
    if (!body.parent_session_id || !body.child_agent_id) {
      return c.json(
        { error: "missing_fields", need: ["parent_session_id", "child_agent_id"] },
        400,
      );
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
      return c.json({ error: "internal_error" }, 500);
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

  return app;
}
