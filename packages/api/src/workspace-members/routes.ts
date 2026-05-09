import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { MembershipRepository } from "@x1agent/domain-workspaces";
import type { UserRepository } from "@x1agent/domain-auth";

/**
 * Read-only "who's in this workspace" surface. Powers UI pickers that
 * need a list of members — today: the agent edit page's "Run as"
 * select for scheduled_run_as_user_id; tomorrow: the active-members
 * roster on the People settings page.
 *
 * Authorization: any workspace member can list members. Roles are
 * returned so the UI can disambiguate viewers/admins where it
 * matters; the picker for "Run as" treats every non-NULL row equally.
 *
 * Cross-tenant isolation: the URL slug resolves to a workspace, the
 * caller must be a member of THAT workspace. Members from other
 * workspaces never leak — `listByWorkspace` is a SQL filter on
 * workspace_id.
 */
export interface WorkspaceMembersRoutesConfig {
  memberships: MembershipRepository;
  users: UserRepository;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (
    c: import("hono").Context,
  ) => { userId: UserId; email: Email } | null;
}

export function createWorkspaceMembersRoutes(
  cfg: WorkspaceMembersRoutesConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);

    const slug = c.req.param("slug")!;
    const wsId = await cfg.resolveWorkspace(WorkspaceSlug(slug));
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    // Caller must be a member to read the roster — visibility tier
    // mirrors workspace_secrets / collections.
    const callerMember = await cfg.memberships.findByUserAndWorkspace(
      actor.userId,
      wsId,
    );
    if (!callerMember) return c.json({ error: "not_a_member" }, 403);

    const rows = await cfg.memberships.listByWorkspace(wsId);

    // Hydrate each membership with the user's email + name. N+1 today
    // because workspaces are typically small (≤ tens of users); switch
    // to a JOIN at the postgres adapter when this surfaces in a flame
    // graph. Skipping rows where the user record is gone — those are
    // stale memberships the revoke-on-delete cascade hasn't cleaned up
    // yet.
    const out: Array<{
      user_id: UserId;
      email: string;
      name: string;
      role: string;
      added_at: string;
    }> = [];
    for (const m of rows) {
      const u = await cfg.users.findById(m.userId);
      if (!u) continue;
      out.push({
        user_id: m.userId,
        email: u.email as unknown as string,
        name: u.name,
        role: m.role as unknown as string,
        added_at: m.addedAt.toISOString(),
      });
    }
    return c.json({ members: out });
  });

  return app;
}
