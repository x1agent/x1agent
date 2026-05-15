import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  Email,
  UserId,
  WorkspaceSlug,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  PreviewEnvironmentId,
  type PreviewEnvironment,
} from "../../domain/preview-environment.js";
import {
  PreviewEnvironmentNotFoundError,
  PreviewEnvironmentNotInWorkspaceError,
  PreviewSlugTakenError,
} from "../../domain/errors.js";
import type { PreviewEnvironmentRepository } from "../../ports/preview-environment-repository.js";
import {
  getPreviewEnvironmentById,
  getPreviewEnvironmentBySlug,
} from "../../application/get-preview-environment.js";
import { listPreviewEnvironments } from "../../application/list-preview-environments.js";

/**
 * Workspace-scoped read + admin-mutation surface for durable preview
 * environments. Mount point:
 *   /api/workspaces/:slug/preview-environments
 *
 * Routes:
 *   GET    /                 list every env in this workspace
 *   GET    /:id              one env (by id)
 *   GET    /by-slug/:slug    one env (by slug — env slug, not workspace slug)
 *   PATCH  /:id              rename (admin only)
 *   DELETE /:id              delete (admin only)
 *
 * Creation is NOT exposed here — environments come into existence via
 * the internal preview-deploy flow (the upsert use case is called by
 * the api when the agent invokes `preview_deploy`).
 */

export interface PreviewEnvironmentRoutesConfig {
  repository: PreviewEnvironmentRepository;
  /**
   * AdminGuard mirrors the shape used in the agents/workspaces routes —
   * called with the actor's workspace_id + user_id; throws on non-admin.
   */
  adminGuard: {
    requireWorkspaceAdmin: (
      workspaceId: WorkspaceId,
      userId: UserId,
    ) => Promise<void>;
  };
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

function serialize(e: PreviewEnvironment) {
  return {
    id: e.id,
    workspace_id: e.workspaceId,
    slug: e.slug,
    title: e.title,
    repo_full_name: e.repoFullName,
    branch: e.branch,
    last_deploy_sha: e.lastDeploySha,
    last_deploy_url: e.lastDeployUrl,
    last_deploy_image_ref: e.lastDeployImageRef,
    last_deploy_status: e.lastDeployStatus,
    last_deploy_status_reason: e.lastDeployStatusReason,
    last_deploy_at: e.lastDeployAt?.toISOString() ?? null,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
  };
}

function errStatus(err: unknown): number {
  if (err instanceof PreviewEnvironmentNotFoundError) return 404;
  if (err instanceof PreviewEnvironmentNotInWorkspaceError) return 404;
  if (err instanceof PreviewSlugTakenError) return 409;
  if (err instanceof DomainError) {
    if (err.code === "admin_denied" || err.code === "not_a_member") return 403;
    if (err.code === "validation_error" || err.code === "invalid_preview_slug")
      return 400;
    return 400;
  }
  throw err;
}

function errBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

export function createPreviewEnvironmentRoutes(
  cfg: PreviewEnvironmentRoutesConfig,
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
    const rows = await listPreviewEnvironments(
      { repository: cfg.repository },
      wsId,
    );
    return c.json({ preview_environments: rows.map(serialize) });
  });

  // GET /by-slug/:envSlug — declared before /:id so the literal path
  // wins the route match over the param.
  app.get("/by-slug/:envSlug", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      const env = await getPreviewEnvironmentBySlug(
        { repository: cfg.repository },
        wsId,
        c.req.param("envSlug")!,
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.get("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      const env = await getPreviewEnvironmentById(
        { repository: cfg.repository },
        wsId,
        PreviewEnvironmentId(c.req.param("id")!),
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.patch("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return c.json({ error: "missing_fields", message: "title required" }, 400);
    }
    try {
      await cfg.adminGuard.requireWorkspaceAdmin(wsId, actor.userId);
      const env = await cfg.repository.rename(
        PreviewEnvironmentId(c.req.param("id")!),
        wsId,
        body.title.trim(),
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await cfg.adminGuard.requireWorkspaceAdmin(wsId, actor.userId);
      // Note: row delete only. Tearing down the cluster Deployment /
      // Service / Ingress is the next slice (NATS request to the
      // preview provider). v1 row delete leaves the K8s resources
      // dangling until the provider's reaper sweep cleans them up.
      await cfg.repository.delete(
        PreviewEnvironmentId(c.req.param("id")!),
        wsId,
      );
      return c.body(null, 204);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
