import { Hono, type MiddlewareHandler } from "hono";
import {
  DomainError,
  Email,
  InvitationId,
  Role,
  WorkspaceSlug,
  type Clock,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { InvitationRepository } from "../../ports/invitation-repository.js";
import type { WorkspaceReader } from "../../ports/workspace-reader.js";
import type { AdminGuard } from "../../ports/admin-guard.js";
import type { MembershipGrantor } from "../../ports/membership-grantor.js";
import type { TokenGenerator } from "../../ports/token-generator.js";
import { InvitationToken, type Invitation } from "../../domain/invitation.js";
import { sendInvitation } from "../../application/send-invitation.js";
import { acceptInvitation } from "../../application/accept-invitation.js";
import { revokeInvitation } from "../../application/revoke-invitation.js";
import { listInvitations } from "../../application/list-invitations.js";
import { InvitationNotFoundError } from "../../domain/errors.js";

export interface InvitationRoutesConfig {
  invitations: InvitationRepository;
  workspaces: WorkspaceReader;
  adminGuard: AdminGuard;
  memberships: MembershipGrantor;
  tokens: TokenGenerator;
  clock: Clock;

  /**
   * Middleware that attaches `session` to the context. Supplied by the
   * composition root; invitations doesn't know how auth is implemented.
   */
  requireAuth: MiddlewareHandler;

  /**
   * Extractor for (userId, email) from the context. Keeps this adapter
   * independent of the auth domain's AuthSession shape.
   */
  getActor: (
    c: Parameters<MiddlewareHandler>[0],
  ) => { userId: UserId; email: Email } | null;
}

function serializeInvitation(i: Invitation) {
  return {
    id: i.id,
    workspace_id: i.workspaceId,
    email: i.email,
    role: i.role,
    token: i.token,
    invited_by: i.invitedBy,
    expires_at: i.expiresAt.toISOString(),
    accepted_at: i.acceptedAt?.toISOString() ?? null,
    revoked_at: i.revokedAt?.toISOString() ?? null,
    created_at: i.createdAt.toISOString(),
  };
}

function publicInvitationView(i: Invitation) {
  return {
    email: i.email,
    role: i.role,
    expires_at: i.expiresAt.toISOString(),
    accepted_at: i.acceptedAt?.toISOString() ?? null,
    revoked_at: i.revokedAt?.toISOString() ?? null,
  };
}

function domainErrorStatus(err: unknown): number {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "invitation_not_found":
        return 404;
      case "invitation_revoked":
      case "invitation_expired":
        return 410;
      case "invitation_already_accepted":
      case "invitation_already_pending":
      case "already_member":
        return 409;
      case "invitation_email_mismatch":
      case "not_a_member":
      case "insufficient_role":
      case "admin_denied":
        return 403;
      default:
        return 400;
    }
  }
  return 500;
}

function domainErrorBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

/**
 * Workspace-scoped routes: `/workspaces/:slug/invitations` (admin-only).
 * Mount under `/api` or similar at the composition root.
 */
export function createWorkspaceInvitationRoutes(
  cfg: InvitationRoutesConfig,
): Hono {
  const app = new Hono();

  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) => {
    let ws: WorkspaceId | null;
    try {
      ws = await cfg.workspaces.getIdBySlug(WorkspaceSlug(slug));
    } catch {
      return null;
    }
    return ws;
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      const rows = await listInvitations(
        { invitations: cfg.invitations, adminGuard: cfg.adminGuard },
        actor.userId,
        wsId,
      );
      return c.json({ invitations: rows.map(serializeInvitation) });
    } catch (err) {
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const body = await c.req
      .json<{ email?: string; role?: string }>()
      .catch(() => ({}));
    if (!body.email) return c.json({ error: "invalid_email" }, 400);

    try {
      const inv = await sendInvitation(
        {
          invitations: cfg.invitations,
          workspaces: cfg.workspaces,
          adminGuard: cfg.adminGuard,
          tokens: cfg.tokens,
          clock: cfg.clock,
        },
        {
          actor: actor.userId,
          workspaceId: wsId,
          email: Email(body.email),
          role: Role(body.role ?? "member"),
        },
      );
      return c.json({ invitation: serializeInvitation(inv) }, 201);
    } catch (err) {
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    try {
      await revokeInvitation(
        {
          invitations: cfg.invitations,
          adminGuard: cfg.adminGuard,
          clock: cfg.clock,
        },
        actor.userId,
        InvitationId(c.req.param("id")!),
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  return app;
}

/**
 * Public token-scoped routes: `/invitations/:token` (lookup + accept).
 * Accept requires auth; lookup does not.
 */
export function createPublicInvitationRoutes(
  cfg: InvitationRoutesConfig,
): Hono {
  const app = new Hono();

  app.get("/:token", async (c) => {
    const inv = await cfg.invitations.findByToken(
      InvitationToken(c.req.param("token")!),
    );
    if (!inv) return c.json({ error: "invitation_not_found" }, 404);
    const ws = await cfg.workspaces.getNameAndSlug(inv.workspaceId);
    if (!ws) return c.json({ error: "invitation_not_found" }, 404);
    return c.json({
      ...publicInvitationView(inv),
      workspace: { slug: ws.slug, name: ws.name },
    });
  });

  app.post("/:token/accept", cfg.requireAuth, async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    try {
      const result = await acceptInvitation(
        {
          invitations: cfg.invitations,
          workspaces: cfg.workspaces,
          memberships: cfg.memberships,
          clock: cfg.clock,
        },
        {
          acceptor: actor.userId,
          acceptorEmail: actor.email,
          token: InvitationToken(c.req.param("token")!),
        },
      );
      return c.json({
        ok: true,
        workspace_slug: result.workspaceSlug,
      });
    } catch (err) {
      if (err instanceof InvitationNotFoundError)
        return c.json(domainErrorBody(err), 404);
      return c.json(domainErrorBody(err), domainErrorStatus(err) as 400);
    }
  });

  return app;
}
