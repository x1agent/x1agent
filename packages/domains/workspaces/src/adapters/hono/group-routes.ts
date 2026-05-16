import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  UserId,
  WorkspaceSlug,
  type Email,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { GroupRepository } from "../../ports/group-repository.js";
import {
  CannotEditMirroredGroupError,
  GroupId,
  GroupNotFoundError,
  GroupSlugTakenError,
} from "../../domain/group.js";

class AdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("only workspace admins can manage groups");
  }
}

export interface GroupRoutesConfig {
  groups: GroupRepository;
  /** Email → user id, used by member-add by-email. */
  findUserIdByEmail: (email: string) => Promise<UserId | null>;
  /** Workspace admin check — only admins can manage groups in v1. */
  isWorkspaceAdmin: (
    userId: UserId,
    workspaceId: WorkspaceId,
  ) => Promise<boolean>;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

// Maps known domain errors to HTTP status. Unknown errors are
// rethrown so Hono's app.onError fires (→ Sentry.captureException).
function statusFor(err: unknown): number {
  if (err instanceof GroupNotFoundError) return 404;
  if (err instanceof GroupSlugTakenError) return 409;
  if (err instanceof CannotEditMirroredGroupError) return 409;
  if (err instanceof DomainError) return 400;
  throw err;
}
function errBody(err: unknown): { error: string; message?: string } {
  if (err instanceof DomainError) return { error: err.code, message: err.message };
  return { error: "internal" };
}

/**
 * Mount under /api/workspaces/:slug/groups.
 *
 * GET /                                       — list groups
 * POST / { slug, name, source?, rule? }       — create
 * DELETE /:groupId                            — delete
 * GET /:groupId/members                       — list members
 * POST /:groupId/members { user_id|email }    — add member (manual only)
 * DELETE /:groupId/members/:userId            — remove member (manual only)
 *
 * SCIM-mirrored groups reject membership writes — sync overwrites
 * them so manual edits would just disappear on the next pass.
 * Dynamic groups have no group_members rows; the resolver evaluates
 * their `rule` instead.
 */
export function createGroupRoutes(cfg: GroupRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) =>
    cfg.resolveWorkspace(WorkspaceSlug(slug));

  const requireAdmin = async (actor: UserId, wsId: WorkspaceId) => {
    if (!(await cfg.isWorkspaceAdmin(actor, wsId))) {
      throw new AdminDeniedError();
    }
  };

  const ensureGroupInWs = async (id: string, wsId: WorkspaceId) => {
    const g = await cfg.groups.findById(GroupId(id));
    if (!g || g.workspaceId !== wsId) return null;
    return g;
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const list = await cfg.groups.listByWorkspace(wsId);
    return c.json({
      groups: list.map((g) => ({
        id: g.id,
        slug: g.slug,
        name: g.name,
        source: g.source,
        external_id: g.externalId,
      })),
    });
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireAdmin(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      slug?: string;
      name?: string;
      source?: "manual" | "scim" | "dynamic";
      external_id?: string;
      rule?: Record<string, unknown>;
    };
    if (!body.slug || !body.name) {
      return c.json({ error: "missing_fields" }, 400);
    }
    try {
      const g = await cfg.groups.create({
        workspaceId: wsId,
        slug: body.slug,
        name: body.name,
        source: body.source ?? "manual",
        externalId: body.external_id,
        rule: body.rule,
      });
      return c.json(
        {
          group: { id: g.id, slug: g.slug, name: g.name, source: g.source },
        },
        201,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
  });

  app.delete("/:groupId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireAdmin(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const g = await ensureGroupInWs(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    await cfg.groups.delete(g.id);
    return c.body(null, 204);
  });

  app.get("/:groupId/members", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const g = await ensureGroupInWs(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    const members = await cfg.groups.listMembers(g.id);
    return c.json({ members });
  });

  app.post("/:groupId/members", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireAdmin(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const g = await ensureGroupInWs(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    if (g.source !== "manual") {
      return c.json(
        errBody(new CannotEditMirroredGroupError(g.source)),
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      user_id?: string;
      email?: string;
    };
    let userId: UserId | null = (body.user_id as UserId | undefined) ?? null;
    if (!userId && body.email) {
      userId = await cfg.findUserIdByEmail(body.email);
    }
    if (!userId) return c.json({ error: "user_not_found" }, 404);
    await cfg.groups.addMember(g.id, userId);
    return c.body(null, 204);
  });

  app.delete("/:groupId/members/:userId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireAdmin(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const g = await ensureGroupInWs(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    if (g.source !== "manual") {
      return c.json(
        errBody(new CannotEditMirroredGroupError(g.source)),
        409,
      );
    }
    await cfg.groups.removeMember(g.id, c.req.param("userId")! as UserId);
    return c.body(null, 204);
  });

  return app;
}
