import { Hono, type MiddlewareHandler } from "hono";
import type { BindingService } from "../../application/binding-service.js";
import type { AgentEnvBinding } from "../../domain/binding.js";

declare module "hono" {
  interface ContextVariableMap {
    workspaceId: string;
    userId: string | null;
  }
}

export interface AgentEnvRoutesConfig {
  service: BindingService;
  requireAuth: MiddlewareHandler;
  /** Validates that :agentId belongs to the slug's workspace. */
  requireAgent: MiddlewareHandler;
}

function bindingToJson(b: AgentEnvBinding) {
  return {
    id: b.id,
    agent_id: b.agentId,
    env_name: b.envName as string,
    secret_name: b.secretName,
    created_at: b.createdAt.toISOString(),
    updated_at: b.updatedAt.toISOString(),
    created_by: b.createdBy,
  };
}

/**
 * Per-agent Zone-2 env bindings. Mounted at
 *   /api/workspaces/:slug/agents/:agentId/env
 *
 * Each row is { env_name, secret_name } — env_name is what the agent
 * container's process.env sees; secret_name is the workspace secret
 * resolved at session-launch via valueFrom.secretKeyRef.
 */
export function createAgentEnvRoutes(cfg: AgentEnvRoutesConfig): Hono {
  const app = new Hono();

  app.use("*", cfg.requireAuth);
  app.use("*", cfg.requireAgent);

  app.get("/", async (c) => {
    const agentId = c.req.param("agentId") ?? "";
    const items = await cfg.service.list(agentId);
    return c.json({ bindings: items.map(bindingToJson) });
  });

  app.put("/:envName", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const userId = c.get("userId") as string | null;
    const agentId = c.req.param("agentId") ?? "";
    const envName = c.req.param("envName") ?? "";
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
      const b = await cfg.service.set({
        agentId,
        workspaceId,
        envName,
        secretName: body.secret_name,
        createdBy: userId,
      });
      return c.json(bindingToJson(b));
    } catch (err) {
      const e = err as { field?: string; message?: string };
      if (e.field) return c.json({ error: e.message, field: e.field }, 400);
      throw err;
    }
  });

  app.delete("/:envName", async (c) => {
    const agentId = c.req.param("agentId") ?? "";
    const envName = c.req.param("envName") ?? "";
    try {
      const removed = await cfg.service.delete(agentId, envName);
      if (!removed) return c.json({ error: "not found" }, 404);
      return c.body(null, 204);
    } catch (err) {
      const e = err as { field?: string; message?: string };
      if (e.field) return c.json({ error: e.message, field: e.field }, 400);
      throw err;
    }
  });

  return app;
}
