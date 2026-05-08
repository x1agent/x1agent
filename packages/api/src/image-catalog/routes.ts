import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { DomainError, WorkspaceSlug, type UserId, type WorkspaceId } from "@x1agent/kernel";
import {
  CannotMutatePresetError,
  ImageCatalogService,
  ImageInUseError,
  ImageNameTakenError,
  ImageNotFoundError,
  NoopBuildQueue,
  PostgresAgentImageRepository,
  type AgentImage,
  type AgentImageUsageReader,
  type BuildQueue,
} from "@x1agent/domain-image-catalog";

type Sql = postgres.Sql<Record<string, unknown>>;

export interface ImageCatalogRoutesConfig {
  sql: Sql;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: import("hono").Context) => { userId: UserId } | null;
  /** Optional override (defaults to NoopBuildQueue while Slice B lands). */
  buildQueue?: BuildQueue;
}

class PostgresAgentImageUsageReader implements AgentImageUsageReader {
  constructor(private readonly sql: Sql) {}
  async agentSlugsUsingImage(
    workspaceId: string,
    imageId: string,
  ): Promise<string[]> {
    const rows = await this.sql<{ slug: string }[]>`
      SELECT slug FROM agents
      WHERE workspace_id = ${workspaceId} AND image_id = ${imageId}
      ORDER BY slug ASC
    `;
    return rows.map((r) => r.slug);
  }
}

function serialize(img: AgentImage) {
  return {
    id: img.id,
    workspace_id: img.workspaceId,
    name: img.name as unknown as string,
    display_name: img.displayName,
    description: img.description,
    built_ref: img.builtRef,
    is_preset: img.isPreset,
    dockerfile_source: img.dockerfileSource as unknown as string,
    build_status: img.buildStatus,
    build_log: img.buildLog,
    last_built_at: img.lastBuiltAt ? img.lastBuiltAt.toISOString() : null,
    created_at: img.createdAt.toISOString(),
  };
}

function statusFor(err: DomainError): 400 | 403 | 404 | 409 {
  if (err instanceof ImageNotFoundError) return 404;
  if (err instanceof CannotMutatePresetError) return 403;
  if (err instanceof ImageNameTakenError) return 409;
  if (err instanceof ImageInUseError) return 409;
  return 400;
}

/**
 * Workspace image catalog. GET is open to every member of the
 * workspace; mutations require the workspace context. Cross-tenant
 * id usage is rejected at the application layer (ImageNotFoundError
 * when the row's workspace_id doesn't match the URL workspace).
 */
export function createWorkspaceImageCatalogRoutes(
  cfg: ImageCatalogRoutesConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const repo = new PostgresAgentImageRepository(cfg.sql);
  const queue = cfg.buildQueue ?? new NoopBuildQueue();
  const usage = new PostgresAgentImageUsageReader(cfg.sql);
  const svc = new ImageCatalogService(repo, queue, usage);

  async function workspaceFromSlug(c: import("hono").Context) {
    const slug = c.req.param("slug")!;
    return cfg.resolveWorkspace(WorkspaceSlug(slug));
  }

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await workspaceFromSlug(c);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const images = await svc.list(wsId as unknown as string);
    return c.json({ images: images.map(serialize) });
  });

  app.get("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await workspaceFromSlug(c);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      const img = await svc.get(wsId as unknown as string, c.req.param("id")!);
      return c.json(serialize(img));
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json(
          { error: err.code, message: err.message },
          statusFor(err),
        );
      }
      throw err;
    }
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await workspaceFromSlug(c);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      display_name?: unknown;
      description?: unknown;
      dockerfile_source?: unknown;
    } | null;
    if (!body) return c.json({ error: "invalid_json" }, 400);
    try {
      const img = await svc.create({
        workspaceId: wsId as unknown as string,
        name: String(body.name ?? ""),
        displayName: String(body.display_name ?? ""),
        description:
          body.description == null ? null : String(body.description),
        dockerfileSource: String(body.dockerfile_source ?? ""),
      });
      return c.json(serialize(img), 201);
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json(
          { error: err.code, message: err.message },
          statusFor(err),
        );
      }
      throw err;
    }
  });

  app.patch("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await workspaceFromSlug(c);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      display_name?: unknown;
      description?: unknown;
      dockerfile_source?: unknown;
    } | null;
    if (!body) return c.json({ error: "invalid_json" }, 400);
    try {
      const img = await svc.update({
        workspaceId: wsId as unknown as string,
        id: c.req.param("id")!,
        displayName:
          body.display_name === undefined
            ? undefined
            : String(body.display_name),
        description:
          body.description === undefined
            ? undefined
            : body.description === null
              ? null
              : String(body.description),
        dockerfileSource:
          body.dockerfile_source === undefined
            ? undefined
            : String(body.dockerfile_source),
      });
      return c.json(serialize(img));
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json(
          { error: err.code, message: err.message },
          statusFor(err),
        );
      }
      throw err;
    }
  });

  app.post("/:id/rebuild", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await workspaceFromSlug(c);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      const img = await svc.requestRebuild(
        wsId as unknown as string,
        c.req.param("id")!,
      );
      return c.json(serialize(img));
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json(
          { error: err.code, message: err.message },
          statusFor(err),
        );
      }
      throw err;
    }
  });

  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await workspaceFromSlug(c);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await svc.delete(wsId as unknown as string, c.req.param("id")!);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json(
          { error: err.code, message: err.message },
          statusFor(err),
        );
      }
      throw err;
    }
  });

  return app;
}
