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
