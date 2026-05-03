import { Hono, type MiddlewareHandler } from "hono";
import type { SecretService } from "../../application/secret-service.js";

// Extend Hono's typed Variables map for the values our middleware sets.
declare module "hono" {
  interface ContextVariableMap {
    workspaceId: string;
    userId: string | null;
  }
}

/**
 * HTTP surface for workspace secrets.
 *
 *   GET    /api/workspaces/:slug/secrets         list (names + is_set only)
 *   PUT    /api/workspaces/:slug/secrets/:name   set / rotate
 *   DELETE /api/workspaces/:slug/secrets/:name   remove
 *
 * Plaintext values are accepted on PUT and never returned on any other
 * route. There is intentionally no GET /value endpoint — operators
 * rotate by setting again, matching the docs' write-only contract.
 *
 * Auth: workspace admin / owner only. Member-tier accounts cannot
 * even list, because the existence and names of secrets are
 * themselves signals we don't want below the admin tier.
 */

export interface SecretsRoutesConfig {
  service: SecretService;
  /** Auth middleware that populates ctx.session. */
  requireAuth: MiddlewareHandler;
}

export function createWorkspaceSecretsRoutes(
  cfg: SecretsRoutesConfig,
): Hono {
  const app = new Hono();

  app.use("*", cfg.requireAuth);

  // Workspace + admin gate. Reads the slug from the route param and
  // matches against the session's cached memberships — no DB hop.
  app.use("*", async (c, next) => {
    const session = c.get("session") as
      | {
          email: string;
          userId: string | null;
          memberships: readonly { slug: string; workspaceId: string; role: string }[];
        }
      | undefined;
    if (!session?.email) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    if (!slug) return c.json({ error: "missing workspace slug" }, 400);
    const m = session.memberships.find((x) => x.slug === slug);
    if (!m) return c.json({ error: "forbidden" }, 403);
    if (m.role !== "admin" && m.role !== "owner") {
      return c.json({ error: "forbidden" }, 403);
    }
    c.set("workspaceId", m.workspaceId);
    c.set("userId", session.userId);
    await next();
  });

  app.get("/", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const items = await cfg.service.list(workspaceId);
    return c.json({
      secrets: items.map((m) => ({
        id: m.id,
        name: m.name,
        is_set: m.isSet,
        created_at: m.createdAt.toISOString(),
        updated_at: m.updatedAt.toISOString(),
        updated_by: m.updatedBy,
      })),
    });
  });

  app.put("/:name", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const userId = c.get("userId") as string | null;
    const name = c.req.param("name") ?? "";
    let body: { value?: unknown };
    try {
      body = (await c.req.json()) as { value?: unknown };
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (typeof body.value !== "string") {
      return c.json({ error: "value must be a string" }, 400);
    }
    try {
      const meta = await cfg.service.set(
        workspaceId,
        name,
        body.value,
        userId,
      );
      return c.json({
        id: meta.id,
        name: meta.name,
        is_set: meta.isSet,
        created_at: meta.createdAt.toISOString(),
        updated_at: meta.updatedAt.toISOString(),
        updated_by: meta.updatedBy,
      });
    } catch (err) {
      const e = err as { field?: string; message?: string; status?: number };
      if (e.field) {
        return c.json({ error: e.message ?? "invalid", field: e.field }, 400);
      }
      throw err;
    }
  });

  app.delete("/:name", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const name = c.req.param("name") ?? "";
    try {
      const removed = await cfg.service.delete(workspaceId, name);
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
