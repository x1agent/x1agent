import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  InvalidAccessGrantValueError,
  normalizeGrantValue,
  type AccessGrantKind,
  type AccessGrantRole,
  type WorkspaceAccessGrant,
} from "../../domain/access-grant.js";
import type { AccessGrantRepository } from "../../ports/access-grant-repository.js";

export interface AccessGrantsRoutesConfig {
  repository: AccessGrantRepository;
  resolveWorkspace: (
    slug: ReturnType<typeof WorkspaceSlug>,
  ) => Promise<WorkspaceId | null>;
  /**
   * Workspace-admin OR platform-admin. Throws on non-admin. The
   * platform-admin bypass is implemented at the composition root —
   * this just calls the gate.
   */
  requireWorkspaceAdminOrPlatformAdmin: (
    workspaceId: WorkspaceId,
    userId: UserId,
    email: Email,
  ) => Promise<void>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

function serialize(g: WorkspaceAccessGrant) {
  return {
    id: g.id,
    workspace_id: g.workspaceId,
    kind: g.kind,
    value: g.value,
    default_role: g.defaultRole,
    expires_at: g.expiresAt?.toISOString() ?? null,
    created_at: g.createdAt.toISOString(),
    created_by: g.createdBy,
  };
}

function errStatus(err: unknown): number {
  if (err instanceof InvalidAccessGrantValueError) return 400;
  if (err instanceof DomainError) {
    if (err.code === "admin_denied" || err.code === "not_a_member") return 403;
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
 * Workspace access grants. Mount point:
 *   /api/workspaces/:slug/access-grants
 *
 * Routes:
 *   GET    /          list every grant in the workspace
 *   POST   /          create or refresh a grant (idempotent on kind+value)
 *   DELETE /:id       revoke a grant
 *
 * All gated to workspace-admin or platform-admin via the
 * requireWorkspaceAdminOrPlatformAdmin hook.
 */
export function createAccessGrantsRoutes(
  cfg: AccessGrantsRoutesConfig,
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
    try {
      await cfg.requireWorkspaceAdminOrPlatformAdmin(
        wsId,
        actor.userId,
        actor.email,
      );
      const rows = await cfg.repository.listForWorkspace(wsId);
      return c.json({ access_grants: rows.map(serialize) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string;
      value?: string;
      default_role?: string | null;
      expires_at?: string | null;
    };
    if (body.kind !== "domain" && body.kind !== "email") {
      return c.json({ error: "kind_must_be_domain_or_email" }, 400);
    }
    if (typeof body.value !== "string" || body.value.trim() === "") {
      return c.json({ error: "value_required" }, 400);
    }
    const defaultRole: AccessGrantRole | null =
      body.default_role === "admin" || body.default_role === "member"
        ? body.default_role
        : null;
    const expiresAt =
      typeof body.expires_at === "string" && body.expires_at !== ""
        ? new Date(body.expires_at)
        : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return c.json({ error: "expires_at_invalid_iso" }, 400);
    }
    try {
      await cfg.requireWorkspaceAdminOrPlatformAdmin(
        wsId,
        actor.userId,
        actor.email,
      );
      const value = normalizeGrantValue(body.kind as AccessGrantKind, body.value);
      const grant = await cfg.repository.upsert({
        workspaceId: wsId,
        kind: body.kind as AccessGrantKind,
        value,
        defaultRole,
        expiresAt,
        createdBy: actor.userId,
      });
      return c.json({ access_grant: serialize(grant) }, 201);
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
      await cfg.requireWorkspaceAdminOrPlatformAdmin(
        wsId,
        actor.userId,
        actor.email,
      );
      const removed = await cfg.repository.delete(
        wsId,
        c.req.param("id") ?? "",
      );
      if (!removed) return c.json({ error: "not_found" }, 404);
      return c.body(null, 204);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
