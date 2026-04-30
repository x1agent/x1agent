import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  WorkspaceSlug,
  makeSubject,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { AgentGrantRepository } from "../../ports/agent-grant-repository.js";
import type { AgentRepository } from "../../ports/agent-repository.js";
import { AgentId } from "../../domain/agent.js";
import {
  AgentGrantId,
  isAgentVerb,
  NotAgentOwnerError,
} from "../../domain/grant.js";

export interface AgentGrantRoutesConfig {
  agents: AgentRepository;
  grants: AgentGrantRepository;
  /** "Resolve grantee email → user id" so the UI can grant by email. */
  findUserIdByEmail: (email: string) => Promise<UserId | null>;
  /** "Is this user a workspace admin?" — bypass for non-owner manage. */
  isWorkspaceAdmin: (
    userId: UserId,
    workspaceId: WorkspaceId,
  ) => Promise<boolean>;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

function statusFor(err: unknown): number {
  if (err instanceof NotAgentOwnerError) return 403;
  if (err instanceof DomainError) return 400;
  return 500;
}
function errBody(err: unknown): { error: string; message?: string } {
  if (err instanceof DomainError) return { error: err.code, message: err.message };
  return { error: "internal" };
}

/**
 * Mount under /api/workspaces/:slug/agents/:agentId/grants
 *
 * GET /                    — list current grants
 * POST /  { subject_kind, subject_id?|email?, verb }   — grant
 * DELETE /:grantId         — revoke
 */
export function createAgentGrantRoutes(cfg: AgentGrantRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) =>
    cfg.resolveWorkspace(WorkspaceSlug(slug));

  const ensureAgentInWs = async (id: string, wsId: WorkspaceId) => {
    const a = await cfg.agents.findById(AgentId(id));
    if (!a || a.workspaceId !== wsId) return null;
    return a;
  };

  const requireOwnerOrAdmin = async (
    actor: UserId,
    agentOwner: UserId | null,
    wsId: WorkspaceId,
  ) => {
    if (agentOwner === actor) return;
    const isAdmin = await cfg.isWorkspaceAdmin(actor, wsId);
    if (!isAdmin) throw new NotAgentOwnerError();
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await ensureAgentInWs(c.req.param("agentId")!, wsId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      await requireOwnerOrAdmin(actor.userId, agent.ownerUserId, wsId);
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
    const list = await cfg.grants.listForAgent(agent.id);
    return c.json({
      visibility: agent.visibility,
      owner_user_id: agent.ownerUserId,
      grants: list.map((g) => ({
        id: g.id,
        agent_id: g.agentId,
        subject_kind: g.subject.kind,
        subject_id: g.subject.id,
        verb: g.verb,
        granted_by: g.grantedBy,
        created_at: g.createdAt.toISOString(),
      })),
    });
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await ensureAgentInWs(c.req.param("agentId")!, wsId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      await requireOwnerOrAdmin(actor.userId, agent.ownerUserId, wsId);
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      subject_kind?: string;
      subject_id?: string;
      email?: string;
      verb?: string;
    };
    if (!isAgentVerb(body.verb ?? "")) {
      return c.json({ error: "invalid_verb" }, 400);
    }
    const verb = body.verb as "view" | "invoke" | "edit";

    let subjectId: string | null = body.subject_id ?? null;
    if (body.subject_kind === "user" && !subjectId && body.email) {
      const u = await cfg.findUserIdByEmail(body.email);
      if (!u) return c.json({ error: "user_not_found" }, 404);
      subjectId = u;
    }
    let subject;
    try {
      subject = makeSubject(body.subject_kind ?? "user", subjectId);
    } catch (err) {
      return c.json(errBody(err), 400);
    }

    const grant = await cfg.grants.upsert({
      agentId: agent.id,
      subject,
      verb,
      grantedBy: actor.userId,
    });
    return c.json(
      {
        grant: {
          id: grant.id,
          agent_id: grant.agentId,
          subject_kind: grant.subject.kind,
          subject_id: grant.subject.id,
          verb: grant.verb,
          granted_by: grant.grantedBy,
          created_at: grant.createdAt.toISOString(),
        },
      },
      201,
    );
  });

  app.delete("/:grantId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agent = await ensureAgentInWs(c.req.param("agentId")!, wsId);
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    try {
      await requireOwnerOrAdmin(actor.userId, agent.ownerUserId, wsId);
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
    await cfg.grants.remove(AgentGrantId(c.req.param("grantId")!));
    return c.body(null, 204);
  });

  return app;
}
