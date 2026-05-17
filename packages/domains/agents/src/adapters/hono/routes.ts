import { Hono, type MiddlewareHandler, type Context } from "hono";
import {
  DomainError,
  Email,
  UserId,
  WorkspaceSlug,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  AgentId,
  AgentNotFoundError,
  AgentSlugTakenError,
  ScheduledRunAsUserNotInWorkspaceError,
  type Agent,
} from "../../domain/agent.js";
import { CronSchedule } from "../../domain/cron-schedule.js";
import { RuntimeType } from "../../domain/runtime.js";
import { AgentKind } from "../../domain/kind.js";
import type { AgentRepository } from "../../ports/agent-repository.js";
import type { AdminGuard } from "../../ports/admin-guard.js";
import type { WorkspaceMemberReader } from "../../ports/workspace-member-reader.js";
import { createAgent } from "../../application/create-agent.js";
import { updateAgent } from "../../application/update-agent.js";
import { deleteAgent } from "../../application/delete-agent.js";
import { listAgents } from "../../application/list-agents.js";

export interface AgentRoutesConfig {
  agents: AgentRepository;
  adminGuard: AdminGuard;
  /**
   * Wired in the composition root. When present, createAgent /
   * updateAgent validate that scheduled_run_as_user_id refers to a
   * member of the agent's workspace before persisting. Optional in
   * tests that don't exercise that field.
   */
  members?: WorkspaceMemberReader;
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
  /**
   * Returns the set of admin-enabled Claude model ids, or null when
   * the deployment isn't curating (resolver not wired). When set, the
   * write path rejects model values that aren't in it — prevents
   * raw-API bypass of the dropdown's strict allowlist.
   */
  enabledModels?: () => Promise<Set<string> | null>;
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
    scheduled_run_as_user_id: a.scheduledRunAsUserId,
    idle_timeout_seconds: a.idleTimeoutSeconds,
    visibility: a.visibility,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  };
}

// Maps known domain errors to HTTP status. Unknown errors are
// rethrown so Hono's app.onError fires (→ Sentry.captureException).
function errStatus(err: unknown): number {
  if (err instanceof AgentNotFoundError) return 404;
  if (err instanceof AgentSlugTakenError) return 409;
  if (err instanceof ScheduledRunAsUserNotInWorkspaceError) return 400;
  if (err instanceof DomainError) {
    if (err.code === "admin_denied" || err.code === "not_a_member" || err.code === "insufficient_role")
      return 403;
    return 400;
  }
  throw err;
}

function errBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

/**
 * Clamp idle_timeout_seconds from a JSON-decoded body value.
 * - null / empty string / unparseable → null (use platform default).
 * - Numbers under 30 → 30 (matches DB CHECK constraint).
 * - Numbers over 604800 (7 d) → 604800 (cap so a typo can't strand
 *   a session pod for years).
 * Mirrors the agents.idle_timeout_seconds CHECK in migration 055.
 */
function clampIdleTimeoutSeconds(raw: unknown): number | null {
  if (raw === null || raw === "" || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(30, Math.min(604_800, Math.floor(n)));
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
      scheduled_run_as_user_id?: string | null;
      idle_timeout_seconds?: number | string | null;
    };
    if (!body.slug || !body.name || !body.runtime_type) {
      return c.json({ error: "missing_fields" }, 400);
    }
    try {
      const a = await createAgent(
        {
          agents: cfg.agents,
          adminGuard: cfg.adminGuard,
          members: cfg.members,
        },
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
          // Empty string from the form is treated as "default to creator"
          // — same shape the rest of the route uses for null/empty.
          scheduledRunAsUserId:
            body.scheduled_run_as_user_id === undefined
              ? undefined
              : body.scheduled_run_as_user_id === null ||
                  body.scheduled_run_as_user_id === ""
                ? null
                : UserId(body.scheduled_run_as_user_id),
          idleTimeoutSeconds:
            body.idle_timeout_seconds === undefined
              ? undefined
              : clampIdleTimeoutSeconds(body.idle_timeout_seconds),
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

    // Reject per-agent model overrides not in the admin-curated list.
    // null/empty is always allowed — that means "use deployment default".
    if (body.model !== undefined && body.model !== null && body.model !== "") {
      const modelStr = String(body.model);
      const enabled = cfg.enabledModels
        ? await cfg.enabledModels()
        : null;
      if (enabled && !enabled.has(modelStr)) {
        return c.json(
          {
            error: "model_not_enabled",
            message:
              "This Claude model is not enabled for the deployment. Ask a platform admin to enable it at /admin/anthropic-models.",
          },
          400,
        );
      }
    }

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
        ...(body.scheduled_run_as_user_id !== undefined && {
          scheduledRunAsUserId:
            body.scheduled_run_as_user_id === null ||
            body.scheduled_run_as_user_id === ""
              ? null
              : UserId(String(body.scheduled_run_as_user_id)),
        }),
        ...(body.idle_timeout_seconds !== undefined && {
          idleTimeoutSeconds: clampIdleTimeoutSeconds(body.idle_timeout_seconds),
        }),
        ...(body.visibility !== undefined && {
          visibility:
            body.visibility === "private" ||
            body.visibility === "workspace" ||
            body.visibility === "via_grants"
              ? body.visibility
              : undefined,
        }),
      };
      const a = await updateAgent(
        {
          agents: cfg.agents,
          adminGuard: cfg.adminGuard,
          members: cfg.members,
        },
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
