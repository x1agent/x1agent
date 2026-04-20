import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
  systemClock,
  type Clock,
} from "@x1agent/kernel";
import {
  AgentId,
  AgentNotFoundError,
  type AgentRepository,
} from "@x1agent/domain-agents";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionEventRepository } from "../../ports/session-event-repository.js";
import type { AdminGuard } from "../../ports/admin-guard.js";
import {
  SessionAlreadyTerminalError,
  SessionDuplicateTickError,
  SessionId,
  SessionNotFoundError,
  type Session,
} from "../../domain/session.js";
import type { SessionEvent } from "../../domain/event.js";
import { triggerSession } from "../../application/trigger-session.js";
import { listSessions } from "../../application/list-sessions.js";
import { cancelSession } from "../../application/cancel-session.js";
import { listSessionEvents } from "../../application/list-session-events.js";
import {
  resumeSession,
  SessionNotTerminalError,
} from "../../application/resume-session.js";

export interface SessionRoutesConfig {
  agents: AgentRepository;
  sessions: SessionRepository;
  events: SessionEventRepository;
  adminGuard: AdminGuard;
  /**
   * slug → workspace id, mirroring the agents + invitations routes. Used
   * only to reject cross-workspace agent ids in the URL.
   */
  resolveWorkspace: (
    slug: WorkspaceSlug,
  ) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
  clock?: Clock;
}

function serialize(s: Session) {
  return {
    id: s.id,
    agent_id: s.agentId,
    triggered_by: s.triggeredBy,
    triggered_by_user_id: s.triggeredByUserId,
    parent_session_id: s.parentSessionId,
    parent_agent_id: s.parentAgentId,
    resumed_from: s.resumedFromSessionId,
    triggered_at: s.triggeredAt.toISOString(),
    status: s.status,
    completed_at: s.completedAt ? s.completedAt.toISOString() : null,
    error_message: s.errorMessage,
    created_at: s.createdAt.toISOString(),
  };
}

function serializeEvent(e: SessionEvent) {
  return {
    id: e.id,
    session_id: e.sessionId,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    timestamp: e.timestamp.toISOString(),
  };
}

function errStatus(err: unknown): number {
  if (err instanceof SessionNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 404;
  if (err instanceof SessionAlreadyTerminalError) return 409;
  if (err instanceof SessionNotTerminalError) return 409;
  if (err instanceof SessionDuplicateTickError) return 409;
  if (err instanceof DomainError) {
    if (
      err.code === "admin_denied" ||
      err.code === "not_a_member" ||
      err.code === "insufficient_role"
    )
      return 403;
    return 400;
  }
  return 500;
}

function errBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

export function createSessionRoutes(cfg: SessionRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const clock = cfg.clock ?? systemClock;

  const resolveWs = async (slug: string) => {
    try {
      return await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return null;
    }
  };

  const assertAgentInWorkspace = async (
    wsId: WorkspaceId,
    agentIdRaw: string,
  ) => {
    const agent = await cfg.agents.findById(AgentId(agentIdRaw));
    if (!agent || agent.workspaceId !== wsId) return null;
    return agent;
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await assertAgentInWorkspace(wsId, c.req.param("agentId")!);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      const limit = Number(c.req.query("limit") ?? 50);
      const rows = await listSessions(
        { agents: cfg.agents, sessions: cfg.sessions, adminGuard: cfg.adminGuard },
        actor.userId,
        agent.id,
        limit,
      );
      return c.json({ sessions: rows.map(serialize) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await assertAgentInWorkspace(wsId, c.req.param("agentId")!);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      const s = await triggerSession(
        {
          agents: cfg.agents,
          sessions: cfg.sessions,
          adminGuard: cfg.adminGuard,
          clock,
        },
        { actor: actor.userId, agentId: agent.id },
      );
      return c.json({ session: serialize(s) }, 201);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.get("/:sessionId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await assertAgentInWorkspace(wsId, c.req.param("agentId")!);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      await cfg.adminGuard.assertAdmin(actor.userId, agent.workspaceId);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
    const session = await cfg.sessions.findById(
      SessionId(c.req.param("sessionId")!),
    );
    if (!session || session.agentId !== agent.id)
      return c.json({ error: "session_not_found" }, 404);
    return c.json({ session: serialize(session) });
  });

  app.get("/:sessionId/events", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await assertAgentInWorkspace(wsId, c.req.param("agentId")!);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      const afterRaw = c.req.query("after_seq");
      const limitRaw = c.req.query("limit");
      const { session, events } = await listSessionEvents(
        {
          agents: cfg.agents,
          sessions: cfg.sessions,
          events: cfg.events,
          adminGuard: cfg.adminGuard,
        },
        actor.userId,
        SessionId(c.req.param("sessionId")!),
        {
          afterSeq: afterRaw !== undefined ? Number(afterRaw) : undefined,
          limit: limitRaw !== undefined ? Number(limitRaw) : undefined,
        },
      );
      if (session.agentId !== agent.id)
        return c.json({ error: "session_not_found" }, 404);
      return c.json({
        session: serialize(session),
        events: events.map(serializeEvent),
      });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.post("/:sessionId/cancel", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await assertAgentInWorkspace(wsId, c.req.param("agentId")!);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      const s = await cancelSession(
        {
          agents: cfg.agents,
          sessions: cfg.sessions,
          adminGuard: cfg.adminGuard,
          clock,
        },
        actor.userId,
        SessionId(c.req.param("sessionId")!),
      );
      // Extra safety: make sure the session belongs to the URL's agent.
      if (s.agentId !== agent.id)
        return c.json({ error: "session_not_found" }, 404);
      return c.json({ session: serialize(s) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}

/**
 * Workspace-scoped session routes — addressable by session id alone.
 * The session detail page URL is `/workspaces/:slug/sessions/:id`
 * (no agent id), so callers use this mount instead of the
 * agent-scoped one above.
 */
export function createWorkspaceSessionRoutes(cfg: SessionRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);
  const clock = cfg.clock ?? systemClock;

  const resolveWs = async (slug: string) => {
    try {
      return await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return null;
    }
  };

  // List every session across every agent in the workspace, newest first.
  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await cfg.adminGuard.assertAdmin(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = Math.max(1, Math.min(500, Number(limitRaw ?? 100)));
    const sessions = await cfg.sessions.listByWorkspace(wsId, limit);
    // Enrich each row with the agent slug + name so the UI table can
    // render "which agent ran this" without a second fetch.
    const agentIds = Array.from(new Set(sessions.map((s) => s.agentId)));
    const agents = await Promise.all(agentIds.map((id) => cfg.agents.findById(id)));
    const byId = new Map(
      agents
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a.id, { id: a.id, slug: a.slug, name: a.name }]),
    );
    return c.json({
      sessions: sessions.map((s) => ({
        ...serialize(s),
        agent: byId.get(s.agentId) ?? null,
      })),
    });
  });

  const loadScoped = async (
    slug: string,
    sessionId: string,
    actorId: UserId,
  ) => {
    const wsId = await resolveWs(slug);
    if (!wsId) return { error: "workspace_not_found" as const };
    const session = await cfg.sessions.findById(SessionId(sessionId));
    if (!session) return { error: "session_not_found" as const };
    const agent = await cfg.agents.findById(session.agentId);
    if (!agent || agent.workspaceId !== wsId)
      return { error: "session_not_found" as const };
    try {
      await cfg.adminGuard.assertAdmin(actorId, agent.workspaceId);
    } catch (err) {
      return { error: "forbidden" as const, raised: err };
    }
    return { session, agent };
  };

  app.get("/:sessionId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const scope = await loadScoped(
      c.req.param("slug")!,
      c.req.param("sessionId")!,
      actor.userId,
    );
    if ("error" in scope) {
      if (scope.error === "forbidden")
        return c.json(errBody(scope.raised), errStatus(scope.raised) as 400);
      return c.json({ error: scope.error }, 404);
    }
    return c.json({
      session: serialize(scope.session),
      agent: {
        id: scope.agent.id,
        slug: scope.agent.slug,
        name: scope.agent.name,
      },
    });
  });

  app.get("/:sessionId/events", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const scope = await loadScoped(
      c.req.param("slug")!,
      c.req.param("sessionId")!,
      actor.userId,
    );
    if ("error" in scope) {
      if (scope.error === "forbidden")
        return c.json(errBody(scope.raised), errStatus(scope.raised) as 400);
      return c.json({ error: scope.error }, 404);
    }
    const afterRaw = c.req.query("after_seq");
    const limitRaw = c.req.query("limit");
    const limit = Math.max(
      1,
      Math.min(5000, limitRaw !== undefined ? Number(limitRaw) : 1000),
    );
    const events = await cfg.events.listBySession(scope.session.id, {
      afterSeq: afterRaw !== undefined ? Number(afterRaw) : undefined,
      limit,
    });

    let parent: {
      session_id: string;
      agent: { id: string; slug: string; name: string };
    } | null = null;
    if (scope.session.parentSessionId && scope.session.parentAgentId) {
      const parentAgent = await cfg.agents.findById(
        scope.session.parentAgentId,
      );
      if (parentAgent) {
        parent = {
          session_id: scope.session.parentSessionId,
          agent: {
            id: parentAgent.id,
            slug: parentAgent.slug,
            name: parentAgent.name,
          },
        };
      }
    }

    const childRows = await cfg.sessions.listChildren(scope.session.id);
    const childAgentIds = Array.from(
      new Set(childRows.map((r) => r.agentId)),
    );
    const childAgents = await Promise.all(
      childAgentIds.map((id) => cfg.agents.findById(id)),
    );
    const byId = new Map(
      childAgents
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a.id, { id: a.id, slug: a.slug, name: a.name }]),
    );
    const children = childRows
      .filter((r) => byId.has(r.agentId))
      .map((r) => ({
        id: r.id,
        status: r.status,
        triggered_at: r.triggeredAt.toISOString(),
        agent: byId.get(r.agentId)!,
      }));

    return c.json({
      session: serialize(scope.session),
      agent: {
        id: scope.agent.id,
        slug: scope.agent.slug,
        name: scope.agent.name,
      },
      events: events.map(serializeEvent),
      parent,
      children,
    });
  });

  // Resume a terminal session. Creates a new pending session in the
  // same workspace that points at the original via `resumed_from`; the
  // job-watcher assembles `/workspace/session_history.md` at spawn
  // time.
  app.post("/:sessionId/resume", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const scope = await loadScoped(
      c.req.param("slug")!,
      c.req.param("sessionId")!,
      actor.userId,
    );
    if ("error" in scope) {
      if (scope.error === "forbidden")
        return c.json(errBody(scope.raised), errStatus(scope.raised) as 400);
      return c.json({ error: scope.error }, 404);
    }
    try {
      const session = await resumeSession(
        {
          agents: cfg.agents,
          sessions: cfg.sessions,
          adminGuard: cfg.adminGuard,
          clock,
        },
        { actor: actor.userId, originalSessionId: scope.session.id },
      );
      return c.json(
        {
          session: serialize(session),
          resumed_from: scope.session.id,
        },
        201,
      );
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
