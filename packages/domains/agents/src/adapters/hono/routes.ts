import { Hono, type MiddlewareHandler, type Context } from "hono";
import {
  DomainError,
  Email,
  WorkspaceSlug,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import { AgentId, AgentNotFoundError, AgentSlugTakenError, type Agent } from "../../domain/agent.js";
import { CronSchedule } from "../../domain/cron-schedule.js";
import { RuntimeType } from "../../domain/runtime.js";
import { AgentKind } from "../../domain/kind.js";
import type { AgentRepository } from "../../ports/agent-repository.js";
import type { AdminGuard } from "../../ports/admin-guard.js";
import { createAgent } from "../../application/create-agent.js";
import { updateAgent } from "../../application/update-agent.js";
import { deleteAgent } from "../../application/delete-agent.js";
import { listAgents } from "../../application/list-agents.js";

export interface AgentRoutesConfig {
  agents: AgentRepository;
  adminGuard: AdminGuard;
  /**
   * Resolver: slug → workspace id. Mirrors the invitations routes — keeps
   * agents independent of the workspaces adapter.
   */
  resolveWorkspace: (
    slug: WorkspaceSlug,
  ) => Promise<WorkspaceId | null>;
  /** Injected by composition — reads session from the ctx. */
  requireAuth: MiddlewareHandler;
  getActor: (
    c: Context,
  ) => { userId: UserId; email: Email } | null;
}

function serialize(a: Agent) {
  return {
    id: a.id,
    workspace_id: a.workspaceId,
    slug: a.slug,
    name: a.name,
    runtime_type: a.runtimeType,
    kind: a.kind,
    system_prompt: a.systemPrompt,
    heartbeat_md: a.heartbeatMd,
    schedule: a.schedule,
    is_active: a.isActive,
    image_id: a.imageId,
    model: a.model,
    created_by: a.createdBy,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  };
}

function errStatus(err: unknown): number {
  if (err instanceof AgentNotFoundError) return 404;
  if (err instanceof AgentSlugTakenError) return 409;
  if (err instanceof DomainError) {
    if (err.code === "admin_denied" || err.code === "not_a_member" || err.code === "insufficient_role")
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

export function createAgentRoutes(cfg: AgentRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) => {
    try {
      return await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return null;
    }
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const rows = await listAgents(cfg.agents, actor.userId, wsId);
    return c.json({ agents: rows.map(serialize) });
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const body = await c.req.json().catch(() => ({})) as {
      slug?: string;
      name?: string;
      runtime_type?: string;
      kind?: string;
      system_prompt?: string;
      heartbeat_md?: string;
      schedule?: string | null;
    };
    if (!body.slug || !body.name || !body.runtime_type) {
      return c.json({ error: "missing_fields" }, 400);
    }
    try {
      const a = await createAgent(
        { agents: cfg.agents, adminGuard: cfg.adminGuard },
        {
          actor: actor.userId,
          workspaceId: wsId,
          slug: WorkspaceSlug(body.slug),
          name: body.name,
          runtimeType: RuntimeType(body.runtime_type),
          kind: body.kind ? AgentKind(body.kind) : undefined,
          systemPrompt: body.system_prompt,
          heartbeatMd: body.heartbeat_md,
          schedule:
            body.schedule === null || body.schedule === undefined
              ? null
              : CronSchedule(body.schedule),
        },
      );
      return c.json({ agent: serialize(a) }, 201);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.get("/:agentId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const a = await cfg.agents.findById(AgentId(c.req.param("agentId")!));
    if (!a || a.workspaceId !== wsId)
      return c.json({ error: "agent_not_found" }, 404);
    return c.json({ agent: serialize(a) });
  });

  app.patch("/:agentId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    try {
      const patch = {
        ...(body.name !== undefined && { name: String(body.name) }),
        ...(body.runtime_type !== undefined && {
          runtimeType: RuntimeType(String(body.runtime_type)),
        }),
        ...(body.kind !== undefined && {
          kind: AgentKind(String(body.kind)),
        }),
        ...(body.system_prompt !== undefined && {
          systemPrompt: String(body.system_prompt),
        }),
        ...(body.heartbeat_md !== undefined && {
          heartbeatMd: String(body.heartbeat_md),
        }),
        ...(body.schedule !== undefined && {
          schedule:
            body.schedule === null
              ? null
              : CronSchedule(String(body.schedule)),
        }),
        ...(body.is_active !== undefined && {
          isActive: Boolean(body.is_active),
        }),
        ...(body.image_id !== undefined && {
          imageId:
            body.image_id === null || body.image_id === ""
              ? null
              : String(body.image_id),
        }),
        ...(body.model !== undefined && {
          model:
            body.model === null || body.model === ""
              ? null
              : String(body.model),
        }),
      };
      const a = await updateAgent(
        { agents: cfg.agents, adminGuard: cfg.adminGuard },
        actor.userId,
        AgentId(c.req.param("agentId")!),
        patch,
      );
      return c.json({ agent: serialize(a) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.delete("/:agentId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    try {
      await deleteAgent(
        { agents: cfg.agents, adminGuard: cfg.adminGuard },
        actor.userId,
        AgentId(c.req.param("agentId")!),
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
