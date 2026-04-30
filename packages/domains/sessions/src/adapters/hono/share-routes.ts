import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionShareRepository } from "../../ports/session-share-repository.js";
import { SessionId } from "../../domain/session.js";
import { SessionShareId } from "../../domain/share.js";
import {
  shareSession,
  unshareSession,
  NotSessionOwnerError,
  SessionNotFoundForShareError,
} from "../../application/manage-session-shares.js";

export interface SessionShareRoutesConfig {
  sessions: SessionRepository;
  shares: SessionShareRepository;
  /** Lookup the user record by email or id, used to resolve share targets. */
  findUserIdByEmail: (email: string) => Promise<UserId | null>;
  /** "Is this user a workspace admin/owner?" — bypass for non-owner shares. */
  isWorkspaceAdmin: (userId: UserId, workspaceId: WorkspaceId) => Promise<boolean>;
  resolveWorkspace: (
    slug: WorkspaceSlug,
  ) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

function statusFor(err: unknown): number {
  if (err instanceof SessionNotFoundForShareError) return 404;
  if (err instanceof NotSessionOwnerError) return 403;
  if (err instanceof DomainError) return 400;
  return 500;
}

function errBody(err: unknown): { error: string; message?: string } {
  if (err instanceof DomainError) {
    return { error: err.code, message: err.message };
  }
  return { error: "internal" };
}

/**
 * Mount under
 *   /api/workspaces/:slug/sessions/:sessionId/user-shares
 *
 * GET /                         — list current grants
 * POST /     { email | user_id, role } — grant or update
 * DELETE /:userId               — revoke
 */
export function createSessionShareRoutes(
  cfg: SessionShareRoutesConfig,
): Hono {
  const app = new Hono();

  const resolveWs = async (slug: string) => {
    return await cfg.resolveWorkspace(WorkspaceSlug(slug));
  };

  const ensureSessionInWs = async (
    sessionId: string,
    wsId: WorkspaceId,
  ) => {
    const s = await cfg.sessions.findById(SessionId(sessionId));
    if (!s) return null;
    if (s.workspaceId !== wsId) return null;
    return s;
  };

  app.use("*", cfg.requireAuth);

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const session = await ensureSessionInWs(c.req.param("sessionId")!, wsId);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    const isOwner = session.triggeredByUserId === actor.userId;
    const isAdmin = await cfg.isWorkspaceAdmin(actor.userId, wsId);
    if (!isOwner && !isAdmin) {
      return c.json({ error: "forbidden" }, 403);
    }

    const list = await cfg.shares.listForSession(SessionId(session.id));
    return c.json({
      shares: list.map((s) => ({
        id: s.id,
        session_id: s.sessionId,
        user_id: s.userId,
        role: s.role,
        shared_by: s.sharedBy,
        created_at: s.createdAt.toISOString(),
      })),
    });
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const session = await ensureSessionInWs(c.req.param("sessionId")!, wsId);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      user_id?: string;
      role?: string;
    };

    let granteeUserId: UserId | null = null;
    if (body.user_id) granteeUserId = body.user_id as UserId;
    else if (body.email) granteeUserId = await cfg.findUserIdByEmail(body.email);
    if (!granteeUserId) return c.json({ error: "user_not_found" }, 404);

    const isAdmin = await cfg.isWorkspaceAdmin(actor.userId, wsId);

    try {
      const share = await shareSession(
        { sessions: cfg.sessions, shares: cfg.shares },
        {
          sessionId: SessionId(session.id),
          granteeUserId,
          role: body.role ?? "viewer",
          actor: actor.userId,
          actorIsWorkspaceAdmin: isAdmin,
        },
      );
      return c.json(
        {
          share: {
            id: share.id,
            session_id: share.sessionId,
            user_id: share.userId,
            role: share.role,
            shared_by: share.sharedBy,
            created_at: share.createdAt.toISOString(),
          },
        },
        201,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
  });

  app.delete("/:userId", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const session = await ensureSessionInWs(c.req.param("sessionId")!, wsId);
    if (!session) return c.json({ error: "session_not_found" }, 404);

    const isAdmin = await cfg.isWorkspaceAdmin(actor.userId, wsId);
    try {
      await unshareSession(
        { sessions: cfg.sessions, shares: cfg.shares },
        {
          sessionId: SessionId(session.id),
          granteeUserId: c.req.param("userId")! as UserId,
          actor: actor.userId,
          actorIsWorkspaceAdmin: isAdmin,
        },
      );
      return c.body(null, 204);
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
  });

  return app;
}

// Keep imports used (TS strict noUnusedLocals).
export { SessionShareId };
