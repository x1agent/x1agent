import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DomainError, ValidationError, type Email, type UserId } from "@x1agent/kernel";
import {
  createWorkspace,
  NotPlatformAdminError,
  WorkspaceSlugTakenError,
  type CreateWorkspaceDeps,
} from "../../application/create-workspace.js";

export interface WorkspaceRoutesConfig {
  workspaces: CreateWorkspaceDeps["workspaces"];
  memberships: CreateWorkspaceDeps["memberships"];
  platformAdmins: readonly string[];
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
  /**
   * Mint a fresh session cookie for the given user with their CURRENT
   * memberships + platform-admin status read from the database. Called
   * after createWorkspace so the caller's JWT picks up the new
   * membership row immediately, instead of waiting for them to sign
   * out and back in. Returns the full Set-Cookie header value the
   * route hands back in the response.
   *
   * Wired at the composition root so the workspaces domain doesn't
   * depend on auth-domain internals (tokenizer, cookie name).
   */
  refreshSessionForUser: (
    userId: UserId,
    email: Email,
  ) => Promise<string>;
}

/**
 * Workspace-scoped routes mounted at /api/workspaces.
 * Currently just one operation: POST / to create a new workspace
 * (platform-admin gated). The list-workspaces endpoint already lives
 * under the auth domain's /api/me payload.
 */
export function createWorkspaceRoutes(cfg: WorkspaceRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);

    let body: { slug?: unknown; name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.slug !== "string" || typeof body.name !== "string") {
      return c.json({ error: "slug_and_name_required" }, 400);
    }

    try {
      const workspace = await createWorkspace(
        {
          workspaces: cfg.workspaces,
          memberships: cfg.memberships,
          platformAdmins: cfg.platformAdmins,
        },
        {
          slug: body.slug,
          name: body.name,
          creatorUserId: actor.userId,
          creatorEmail: actor.email,
        },
      );
      // Refresh the caller's session cookie so the new owner-membership
      // row is reflected in the JWT immediately. Without this the
      // very next request to /workspaces/<slug> 403s — the auth
      // middleware reads memberships from the JWT, which was minted at
      // sign-in time when the user had none.
      const cookieValue = await cfg.refreshSessionForUser(
        actor.userId,
        actor.email,
      );
      c.header("Set-Cookie", cookieValue);
      return c.json({
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
      });
    } catch (err) {
      if (err instanceof NotPlatformAdminError) {
        return c.json({ error: "forbidden", reason: err.message }, 403);
      }
      if (err instanceof WorkspaceSlugTakenError) {
        return c.json({ error: "slug_taken", slug: err.slug }, 409);
      }
      if (err instanceof ValidationError) {
        return c.json({ error: "validation", field: err.field, message: err.message }, 400);
      }
      if (err instanceof DomainError) {
        return c.json({ error: "domain", message: err.message }, 400);
      }
      throw err;
    }
  });

  return app;
}
