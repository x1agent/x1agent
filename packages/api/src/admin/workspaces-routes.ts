import { Hono, type MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { Email } from "@x1agent/kernel";
import { isPlatformAdmin } from "@x1agent/domain-auth";

/**
 * Cross-workspace admin surface. Returns every workspace in the
 * deployment with member + agent counts so platform admins can see
 * tenants without joining each one. Read-only; mutation lives in the
 * per-workspace surface where it belongs.
 */

export interface AdminWorkspacesConfig {
  sql: postgres.Sql<Record<string, unknown>>;
  platformAdmins: readonly string[];
  requireAuth: MiddlewareHandler;
}

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
  member_count: string;
  agent_count: string;
}

export function createAdminWorkspacesRoutes(
  cfg: AdminWorkspacesConfig,
): Hono {
  const app = new Hono();

  app.use("*", cfg.requireAuth);
  app.use("*", async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    if (!isPlatformAdmin(Email(session.email), cfg.platformAdmins)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  app.get("/", async (c) => {
    const rows = await cfg.sql<WorkspaceRow[]>`
      SELECT
        w.id,
        w.slug,
        w.name,
        w.created_at,
        COALESCE(m.member_count, 0)::text AS member_count,
        COALESCE(a.agent_count,  0)::text AS agent_count
      FROM workspaces w
      LEFT JOIN (
        SELECT workspace_id, COUNT(*) AS member_count
        FROM memberships GROUP BY workspace_id
      ) m ON m.workspace_id = w.id
      LEFT JOIN (
        SELECT workspace_id, COUNT(*) AS agent_count
        FROM agents GROUP BY workspace_id
      ) a ON a.workspace_id = w.id
      ORDER BY w.created_at DESC
    `;

    return c.json({
      workspaces: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        created_at: r.created_at.toISOString(),
        member_count: Number(r.member_count),
        agent_count: Number(r.agent_count),
      })),
    });
  });

  return app;
}
