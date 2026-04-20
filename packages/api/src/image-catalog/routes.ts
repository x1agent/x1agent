import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { WorkspaceSlug, type UserId, type WorkspaceId } from "@x1agent/kernel";

type Sql = postgres.Sql<Record<string, unknown>>;

export interface ImageCatalogRoutesConfig {
  sql: Sql;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: import("hono").Context) => { userId: UserId } | null;
}

interface Row {
  id: string;
  workspace_id: string | null;
  name: string;
  display_name: string;
  description: string | null;
  built_ref: string;
  is_preset: boolean;
  created_at: Date | string;
}

function serialize(r: Row) {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    name: r.name,
    display_name: r.display_name,
    description: r.description,
    built_ref: r.built_ref,
    is_preset: r.is_preset,
    created_at:
      typeof r.created_at === "string"
        ? r.created_at
        : r.created_at.toISOString(),
  };
}

/**
 * Read-only listing of agent_images a workspace may pick from. Returns
 * every platform preset (workspace_id IS NULL) plus any image scoped
 * to the given workspace. Phase 2 adds POST/PATCH for workspace-
 * authored Dockerfiles; Phase 1 is read-only against seeded presets.
 */
export function createWorkspaceImageCatalogRoutes(
  cfg: ImageCatalogRoutesConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await cfg.resolveWorkspace(WorkspaceSlug(c.req.param("slug")!));
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const rows = await cfg.sql<Row[]>`
      SELECT id, workspace_id, name, display_name, description, built_ref,
             is_preset, created_at
      FROM agent_images
      WHERE workspace_id IS NULL OR workspace_id = ${wsId}
      ORDER BY is_preset DESC, name ASC
    `;
    return c.json({ images: rows.map(serialize) });
  });

  return app;
}
