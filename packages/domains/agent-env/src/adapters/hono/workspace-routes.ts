import { Hono, type Context, type MiddlewareHandler } from "hono";
import { WorkspaceSlug } from "@x1agent/kernel";
import type { WorkspaceBindingService } from "../../application/workspace-binding-service.js";
import type { WorkspaceEnvBinding } from "../../domain/workspace-binding.js";

export interface WorkspaceEnvRoutesConfig {
  service: WorkspaceBindingService;
  resolveWorkspace: (
    slug: ReturnType<typeof WorkspaceSlug>,
  ) => Promise<string | null>;
  requireAuth: MiddlewareHandler;
  /**
   * Workspace-admin gate; the agent-side equivalent runs through
   * AdminGuard.requireWorkspaceAdmin. Same shape applied here so the
   * workspace-binding UI can only be driven by admins.
   */
  requireWorkspaceAdmin: (
    workspaceId: string,
    userId: string,
  ) => Promise<void>;
  getActor: (c: Context) => { userId: string; email: string } | null;
}

function bindingToJson(b: WorkspaceEnvBinding) {
  return {
    id: b.id,
    workspace_id: b.workspaceId,
    env_name: b.envName as string,
    secret_name: b.secretName,
    created_at: b.createdAt.toISOString(),
    updated_at: b.updatedAt.toISOString(),
    created_by: b.createdBy,
  };
}

/**
 * Workspace-scoped Zone-2 env bindings. Mounted at
 *   /api/workspaces/:slug/env-bindings
 *
 * Each row is { env_name, secret_name }. Agent sessions opt in by
 * binding the same env name on their agent; preview environments opt
 * in by listing the name in their `env_var_names` array.
 */
export function createWorkspaceEnvRoutes(
  cfg: WorkspaceEnvRoutesConfig,
): Hono {
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
    const items = await cfg.service.list(wsId);
    return c.json({ bindings: items.map(bindingToJson) });
  });

  app.put("/:envName", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    let body: { secret_name?: unknown };
    try {
      body = (await c.req.json()) as { secret_name?: unknown };
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (typeof body.secret_name !== "string") {
      return c.json(
        { error: "secret_name must be a string", field: "secret_name" },
        400,
      );
    }
    try {
      await cfg.requireWorkspaceAdmin(wsId, actor.userId);
      const b = await cfg.service.set({
        workspaceId: wsId,
        envName: c.req.param("envName") ?? "",
        secretName: body.secret_name,
        createdBy: actor.userId,
      });
      return c.json(bindingToJson(b));
    } catch (err) {
      const e = err as { field?: string; message?: string; code?: string };
      if (e.field) return c.json({ error: e.message, field: e.field }, 400);
      if (e.code === "admin_denied") return c.json({ error: e.code }, 403);
      throw err;
    }
  });

  app.delete("/:envName", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await cfg.requireWorkspaceAdmin(wsId, actor.userId);
      const removed = await cfg.service.delete(
        wsId,
        c.req.param("envName") ?? "",
      );
      if (!removed) return c.json({ error: "not found" }, 404);
      return c.body(null, 204);
    } catch (err) {
      const e = err as { field?: string; message?: string; code?: string };
      if (e.field) return c.json({ error: e.message, field: e.field }, 400);
      if (e.code === "admin_denied") return c.json({ error: e.code }, 403);
      throw err;
    }
  });

  return app;
}
