import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  UserId,
  WorkspaceSlug,
  type Email,
  type WorkspaceId,
} from "@x1agent/kernel";
import type {
  GroupRepository,
  GroupListEntry,
} from "../../ports/group-repository.js";
import {
  CannotEditMirroredGroupError,
  GroupArchivedError,
  GroupId,
  GroupNameInvalidError,
  GroupNameTakenError,
  GroupNotFoundError,
  GroupSlugTakenError,
  validateGroupDescription,
  validateGroupName,
} from "../../domain/group.js";

class AdminDeniedError extends DomainError {
  readonly code = "admin_denied";
  constructor() {
    super("only workspace admins can manage groups");
  }
}

class NotAMemberError extends DomainError {
  readonly code = "not_a_member";
  constructor() {
    super("not a member of this workspace");
  }
}

export interface GroupRoutesConfig {
  groups: GroupRepository;
  /** Email → user id, used by member-add by-email. */
  findUserIdByEmail: (email: string) => Promise<UserId | null>;
  /**
   * X1A-107 — used by GET /:groupId to hydrate each member's
   * display_name + email. Kept as a port so the routes don't depend on
   * the auth domain's UserRepository type — the composition root
   * supplies the adapter.
   */
  findUserById: (
    userId: UserId,
  ) => Promise<{ id: UserId; email: string; name: string } | null>;
  /**
   * X1A-107 — used by POST /:groupId/members to reject users from
   * other workspaces with 400 user_not_in_workspace. The spec is
   * explicit that cross-workspace membership is impossible.
   */
  isUserInWorkspace: (
    userId: UserId,
    workspaceId: WorkspaceId,
  ) => Promise<boolean>;
  /**
   * Workspace admin check. X1A-107 spec says "any workspace member can
   * manage" but for THIS PR we keep the existing admin gate (see PR
   * description — flagged for CEO decision). Loosening to any-member
   * is a one-line change in the route handlers below.
   */
  isWorkspaceAdmin: (
    userId: UserId,
    workspaceId: WorkspaceId,
  ) => Promise<boolean>;
  /**
   * X1A-107 — any-member check for read endpoints (list, detail,
   * memberships). Reads are accessible to every workspace member.
   */
  isWorkspaceMember: (
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
  if (err instanceof GroupNameTakenError) return 409;
  if (err instanceof GroupArchivedError) return 410;
  if (err instanceof GroupNameInvalidError) return 400;
  if (err instanceof CannotEditMirroredGroupError) return 409;
  if (err instanceof DomainError) return 400;
  throw err;
}
function errBody(err: unknown): { error: string; message?: string } {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal" };
}

/**
 * X1A-107 — derive a URL-safe slug from a display name. We keep the
 * `slug` column from migration 027 so the agent-grants flow (which
 * historically referenced groups by slug) keeps working unchanged.
 * Callers that don't care can omit `slug` from the request body.
 */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "group"
  );
}

/**
 * Mount under /api/workspaces/:slug/groups.
 *
 * X1A-107 surface (in addition to the pre-existing endpoints):
 *
 *   GET    /                         — list ACTIVE groups + member_count
 *   POST   /                         — create; auto-adds creator
 *   GET    /:groupId                 — detail incl. hydrated members
 *   PATCH  /:groupId                 — update name / description
 *   DELETE /:groupId                 — SOFT delete (sets archived_at)
 *   GET    /:groupId/members         — list member user ids
 *   POST   /:groupId/members         — bulk add { user_ids: [...] }
 *                                       (legacy { user_id, email } also accepted)
 *   DELETE /:groupId/members/:userId — remove a single member
 *   GET    /memberships              — caller's groups (UI affordance)
 *
 * Resolution-at-share-time semantics (X1A-15 decision: groups resolve
 * to user ids AT SHARE-TIME, not retroactively) are NOT implemented
 * here — that's X1A-109 (share-recipient-picker extension). The
 * archived-at column on groups + the FK from share rows to group ids
 * is the half this PR provides; X1A-109 captures the snapshot when a
 * share is created.
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

  const requireMember = async (actor: UserId, wsId: WorkspaceId) => {
    if (!(await cfg.isWorkspaceMember(actor, wsId))) {
      throw new NotAMemberError();
    }
  };

  const requireAdmin = async (actor: UserId, wsId: WorkspaceId) => {
    if (!(await cfg.isWorkspaceAdmin(actor, wsId))) {
      throw new AdminDeniedError();
    }
  };

  /**
   * Loads a group and asserts it's in the actor's workspace + active.
   * 404 covers all three failure modes — never-existed, in a different
   * workspace (don't leak cross-tenant ids), or archived. The brief on
   * X1A-107 says: "Cross-workspace probe → 404 (not 403, don't leak)".
   */
  const loadActiveGroup = async (id: string, wsId: WorkspaceId) => {
    const g = await cfg.groups.findActiveInWorkspace(GroupId(id), wsId);
    return g;
  };

  // ── GET /memberships — caller's groups ──────────────────────────
  //
  // Placed BEFORE the /:groupId routes so Hono's matcher doesn't
  // interpret "memberships" as a group id. Hono's trie should resolve
  // the static route first regardless, but ordering here is defensive.
  app.get("/memberships", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireMember(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const groups = await cfg.groups.listGroupsForUser(wsId, actor.userId);
    return c.json({
      groups: groups.map((g) => ({
        id: g.id,
        slug: g.slug,
        name: g.name,
        description: g.description,
      })),
    });
  });

  // ── GET / — list active groups ──────────────────────────────────
  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireMember(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const list: readonly GroupListEntry[] =
      await cfg.groups.listActiveByWorkspace(wsId);
    return c.json({
      groups: list.map((g) => ({
        id: g.id,
        slug: g.slug,
        name: g.name,
        description: g.description,
        source: g.source,
        external_id: g.externalId,
        member_count: g.memberCount,
        created_at: g.createdAt.toISOString(),
        created_by: g.createdBy,
      })),
    });
  });

  // ── POST / — create ─────────────────────────────────────────────
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
      description?: string | null;
      source?: "manual" | "scim" | "dynamic";
      external_id?: string;
      rule?: Record<string, unknown>;
    };
    if (!body.name) {
      return c.json({ error: "missing_fields" }, 400);
    }
    let name: string;
    let description: string | null;
    try {
      name = validateGroupName(body.name);
      description = validateGroupDescription(body.description);
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
    const source = body.source ?? "manual";
    // X1A-107 — for manual groups, also reject duplicate name up-front
    // (the DB unique index would catch it, but doing it explicitly
    // gives us a clean 409 with the right error code regardless of
    // race conditions on the constraint name).
    if (source === "manual") {
      const dupe = await cfg.groups.findActiveByName(wsId, name);
      if (dupe) {
        return c.json(errBody(new GroupNameTakenError(name)), 409);
      }
    }
    const slug = body.slug?.trim() || slugify(name);
    try {
      const g = await cfg.groups.create({
        workspaceId: wsId,
        slug,
        name,
        description,
        source,
        externalId: body.external_id,
        rule: body.rule,
        createdBy: source === "manual" ? actor.userId : null,
      });
      // X1A-107 — auto-add creator for manual groups. The spec is
      // explicit: "creator appears in members on first read". For
      // SCIM/dynamic the membership is upstream-managed; we don't
      // pollute it.
      if (source === "manual") {
        await cfg.groups.addMember(g.id, actor.userId, actor.userId);
      }
      return c.json(
        {
          group: {
            id: g.id,
            slug: g.slug,
            name: g.name,
            description: g.description,
            source: g.source,
            created_at: g.createdAt.toISOString(),
            created_by: g.createdBy,
          },
        },
        201,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
  });

  // ── GET /:groupId — detail with hydrated members ────────────────
  app.get("/:groupId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireMember(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const g = await loadActiveGroup(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    const memberships = await cfg.groups.listMemberships(g.id);
    // Hydrate display_name + email. N+1 over members is fine for
    // group sizes we expect (tens at most); revisit at scale.
    const hydrated: Array<{
      user_id: string;
      display_name: string;
      email: string;
      added_at: string;
      added_by: string | null;
    }> = [];
    for (const m of memberships) {
      const u = await cfg.findUserById(m.userId);
      if (!u) continue;
      hydrated.push({
        user_id: m.userId,
        display_name: u.name,
        email: u.email,
        added_at: m.addedAt.toISOString(),
        added_by: m.addedBy,
      });
    }
    hydrated.sort((a, b) => a.display_name.localeCompare(b.display_name));
    return c.json({
      group: {
        id: g.id,
        slug: g.slug,
        name: g.name,
        description: g.description,
        source: g.source,
        created_at: g.createdAt.toISOString(),
        created_by: g.createdBy,
        members: hydrated,
      },
    });
  });

  // ── PATCH /:groupId — update name / description ─────────────────
  app.patch("/:groupId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireAdmin(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const g = await loadActiveGroup(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string | null;
    };
    let name: string | undefined;
    let description: string | null | undefined;
    try {
      if (body.name !== undefined) name = validateGroupName(body.name);
      if (body.description !== undefined)
        description = validateGroupDescription(body.description);
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
    // Pre-check duplicate name to give a clean 409 (the DB constraint
    // would catch it too, but only on the rename path of update()).
    if (name !== undefined && name.toLowerCase() !== g.name.toLowerCase()) {
      const dupe = await cfg.groups.findActiveByName(wsId, name);
      if (dupe && dupe.id !== g.id) {
        return c.json(errBody(new GroupNameTakenError(name)), 409);
      }
    }
    try {
      const updated = await cfg.groups.update(g.id, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return c.json({
        group: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          description: updated.description,
          source: updated.source,
        },
      });
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
  });

  // ── DELETE /:groupId — SOFT delete ──────────────────────────────
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
    // Note: we resolve with findById here (not loadActiveGroup) so a
    // second DELETE on an already-archived group returns 204 idempotent
    // rather than 404. Still scoped to the workspace.
    const g = await cfg.groups.findById(GroupId(c.req.param("groupId")!));
    if (!g || g.workspaceId !== wsId) {
      return c.json({ error: "group_not_found" }, 404);
    }
    await cfg.groups.archive(g.id);
    return c.body(null, 204);
  });

  app.get("/:groupId/members", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await requireMember(actor.userId, wsId);
    } catch (err) {
      return c.json(errBody(err), 403);
    }
    const g = await loadActiveGroup(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    const members = await cfg.groups.listMembers(g.id);
    return c.json({ members });
  });

  // ── POST /:groupId/members — bulk add ───────────────────────────
  //
  // Two body shapes accepted:
  //   * X1A-107 bulk:  { user_ids: ["uuid", "uuid", ...] }
  //   * Legacy single: { user_id: "uuid" } OR { email: "..." }
  //
  // The bulk shape is the canonical one going forward; the legacy
  // shape is kept so the agent-grants codepath (which hits this route
  // today for individual adds by email) doesn't break.
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
    const g = await loadActiveGroup(c.req.param("groupId")!, wsId);
    if (!g) return c.json({ error: "group_not_found" }, 404);
    if (g.source !== "manual") {
      return c.json(
        errBody(new CannotEditMirroredGroupError(g.source)),
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      user_ids?: string[];
      user_id?: string;
      email?: string;
    };

    // Resolve the incoming shape to a list of UserId values.
    let userIds: UserId[] = [];
    if (Array.isArray(body.user_ids) && body.user_ids.length > 0) {
      userIds = body.user_ids.map((u) => u as UserId);
    } else if (body.user_id) {
      userIds = [body.user_id as UserId];
    } else if (body.email) {
      const u = await cfg.findUserIdByEmail(body.email);
      if (!u) return c.json({ error: "user_not_found" }, 404);
      userIds = [u];
    } else {
      return c.json({ error: "missing_fields" }, 400);
    }

    // Cross-tenant guard — every id must belong to the workspace.
    // The brief & X1A-107 spec both call out this exact error code.
    for (const uid of userIds) {
      const ok = await cfg.isUserInWorkspace(uid, wsId);
      if (!ok) {
        return c.json(
          {
            error: "user_not_in_workspace",
            user_id: uid,
          },
          400,
        );
      }
    }

    await cfg.groups.addMembers(g.id, userIds, actor.userId);

    // Return the updated member id list — matches the spec's "returns
    // the updated member list" line. Routes elsewhere in the app use
    // ids-only on bulk responses; the detail endpoint is one hop away
    // when the UI needs hydration.
    const members = await cfg.groups.listMembers(g.id);
    return c.json({ members });
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
    const g = await loadActiveGroup(c.req.param("groupId")!, wsId);
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
