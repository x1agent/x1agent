import { Hono, type MiddlewareHandler } from "hono";
import { DomainError, UserId } from "@x1agent/kernel";
import type { UserRepository } from "../../ports/user-repository.js";
import { parseGitIdentity } from "../../domain/git-identity.js";

/**
 * Per-user account-management routes mounted under /api/me.
 *
 * Scope guardrail: every route in here only reads/writes the
 * authenticated session's OWN userId. There is no `/api/users/:id`
 * variant, on purpose — opening a cross-user surface would invite
 * IDOR mistakes downstream (one workspace admin reading another
 * user's git identity, etc.). When a future feature genuinely needs
 * cross-user reads (e.g. workspace admin views git_email for audit),
 * it should land as a separate workspace-scoped route with its own
 * RBAC check.
 */
export interface MeRoutesConfig {
  users: UserRepository;
  requireAuth: MiddlewareHandler;
}

export function createMeRoutes(cfg: MeRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  // GET /api/me/git-identity → { git_identity: { name, email } | null }
  app.get("/git-identity", async (c) => {
    const session = c.get("session");
    const user = await cfg.users.findById(UserId(session.userId));
    if (!user) return c.json({ error: "user_not_found" }, 404);
    return c.json({
      git_identity: user.gitIdentity
        ? { name: user.gitIdentity.name, email: user.gitIdentity.email }
        : null,
    });
  });

  // PUT /api/me/git-identity body: { name, email } → 200 { git_identity }
  // DELETE /api/me/git-identity                    → 204
  app.put("/git-identity", async (c) => {
    const session = c.get("session");
    const raw = (await c.req
      .json<{ name?: unknown; email?: unknown }>()
      .catch(() => ({}))) as { name?: unknown; email?: unknown };
    const rawName = raw.name;
    const rawEmail = raw.email;
    if (typeof rawName !== "string" || typeof rawEmail !== "string") {
      return c.json(
        { error: "validation_error", message: "name and email are required strings" },
        400,
      );
    }
    try {
      const identity = parseGitIdentity({
        name: rawName,
        email: rawEmail,
      });
      await cfg.users.setGitIdentity(UserId(session.userId), identity);
      return c.json({
        git_identity: { name: identity.name, email: identity.email },
      });
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json(
          {
            error: err.code,
            field: (err as { field?: string }).field ?? null,
            message: err.message,
          },
          400,
        );
      }
      throw err;
    }
  });

  app.delete("/git-identity", async (c) => {
    const session = c.get("session");
    await cfg.users.setGitIdentity(UserId(session.userId), null);
    return c.body(null, 204);
  });

  return app;
}
