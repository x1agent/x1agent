import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  WorkspaceSlug,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  SharedResourceKind,
  type SharedResource,
} from "../../domain/shared-resource.js";
import type { SharedResourceRepository } from "../../ports/shared-resource-repository.js";
import { listWorkspaceResources } from "../../application/list-resources.js";
import { loadStaticCatalog, type CatalogEntry } from "../../catalog.js";

/**
 * Narrow port: "is this user an admin of this workspace?" — same shape
 * every other domain's routes use. Wired by the composition root.
 */
export interface WorkspaceAdminGuard {
  assertAdmin(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}

export interface KindInstallRequest {
  workspaceId: WorkspaceId;
  namespace: string;
  version: string;
  config: Record<string, unknown>;
  installedBy: UserId | null;
}

/**
 * Engine-specific installer. Each engine's package supplies one. The
 * shared routes dispatch on `kind` in the request body.
 */
export type KindInstaller = (
  req: KindInstallRequest,
) => Promise<SharedResource>;

export type KindUninstaller = (resource: SharedResource) => Promise<void>;

/**
 * Per-engine "reset a single branch" hook. Drops + re-templates a
 * Postgres database, or DELs + recreates a Redis ACL user. The
 * agent's next session re-provisions on the mint path.
 */
export type BranchResetter = (input: {
  resource: SharedResource;
  branchId: string;
}) => Promise<void>;

export interface SharedAgentResourcesRoutesConfig {
  resources: SharedResourceRepository;
  installers: Partial<Record<SharedResourceKind, KindInstaller>>;
  uninstallers: Partial<Record<SharedResourceKind, KindUninstaller>>;
  branchResetters: Partial<Record<SharedResourceKind, BranchResetter>>;
  /**
   * Lookup branch_id by (resource, repo_full_name, branch_name) — we
   * hash-sanitize the branch name in the domain layer; the routes need
   * to be able to find existing rows without recomputing the id.
   */
  findBranchId: (input: {
    kind: SharedResourceKind;
    resourceId: string;
    repoFullName: string;
    branchName: string;
  }) => Promise<string | null>;
  adminGuard: WorkspaceAdminGuard;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  /** Namespace where workspace-scoped K8s resources live. */
  workspaceNamespace: string;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId } | null;
}

function serialize(r: SharedResource) {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    kind: r.kind,
    version: r.version,
    provider: r.provider,
    config: r.config,
    status: r.status,
    status_reason: r.statusReason,
    installed_by: r.installedBy,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function errStatus(err: unknown): number {
  if (err instanceof DomainError) {
    if (err.code === "resource_kind_already_installed") return 409;
    if (err.code === "invalid_resource_kind") return 400;
    if (err.code === "resource_not_found") return 404;
    if (
      err.code === "admin_denied" ||
      err.code === "not_a_member" ||
      err.code === "insufficient_role"
    )
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

export function createSharedAgentResourcesRoutes(
  cfg: SharedAgentResourcesRoutesConfig,
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

  // Catalog — what the platform can install. Source is the code-embedded
  // loadStaticCatalog(); `available` is decorated per deployment based
  // on which installers the composition root wired in.
  app.get("/catalog", (c) => {
    const entries: CatalogEntry[] = loadStaticCatalog().map((entry) => ({
      ...entry,
      available: Boolean(cfg.installers[entry.kind]),
    }));
    return c.json({ entries });
  });

  // List installed.
  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const rows = await listWorkspaceResources(cfg.resources, wsId);
    return c.json({ resources: rows.map(serialize) });
  });

  // Install.
  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string;
      version?: string;
      config?: Record<string, unknown>;
    };
    if (!body.kind || !body.version) {
      return c.json({ error: "missing_fields" }, 400);
    }
    try {
      await cfg.adminGuard.assertAdmin(actor.userId, wsId);
      const kind = SharedResourceKind(body.kind);
      const installer = cfg.installers[kind];
      if (!installer) {
        return c.json(
          {
            error: "kind_not_available",
            message: `the ${kind} installer is not wired in this deployment`,
          },
          501,
        );
      }
      const resource = await installer({
        workspaceId: wsId,
        namespace: cfg.workspaceNamespace,
        version: body.version,
        config: body.config ?? {},
        installedBy: actor.userId,
      });
      return c.json({ resource: serialize(resource) }, 201);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  // Reset a single branch's DB / ACL user. Drops the backing data and
  // the next session on that (repo, branch) re-provisions from the main
  // template. Destructive at the branch scope; other branches are
  // untouched.
  app.post("/:id/branches/:branch/reset", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const id = c.req.param("id")!;
    const branchName = decodeURIComponent(c.req.param("branch")!);
    const body = (await c.req.json().catch(() => ({}))) as {
      repo_full_name?: string;
    };
    if (!body.repo_full_name) {
      return c.json({ error: "missing_fields", message: "repo_full_name is required" }, 400);
    }
    try {
      await cfg.adminGuard.assertAdmin(actor.userId, wsId);
      const resource = await cfg.resources.findById(id as never);
      if (!resource || resource.workspaceId !== wsId) {
        return c.json({ error: "resource_not_found" }, 404);
      }
      const resetter = cfg.branchResetters[resource.kind];
      if (!resetter) {
        return c.json(
          {
            error: "kind_not_available",
            message: `reset is not available for ${resource.kind}`,
          },
          501,
        );
      }
      const branchId = await cfg.findBranchId({
        kind: resource.kind,
        resourceId: resource.id,
        repoFullName: body.repo_full_name,
        branchName,
      });
      if (!branchId) {
        return c.json({ error: "branch_not_provisioned" }, 404);
      }
      await resetter({ resource, branchId });
      return c.json({ ok: true, branch_id: branchId });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  // Uninstall — destructive. The client is expected to confirm out-of-band.
  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const id = c.req.param("id")!;
    try {
      await cfg.adminGuard.assertAdmin(actor.userId, wsId);
      const resource = await cfg.resources.findById(id as never);
      if (!resource || resource.workspaceId !== wsId) {
        return c.json({ error: "resource_not_found" }, 404);
      }
      const uninstaller = cfg.uninstallers[resource.kind];
      if (uninstaller) {
        await uninstaller(resource);
      }
      await cfg.resources.delete(resource.id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
