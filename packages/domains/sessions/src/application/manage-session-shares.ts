import type { Email, UserId } from "@x1agent/kernel";
import { DomainError } from "@x1agent/kernel";
import type { SessionRepository } from "../ports/session-repository.js";
import type { SessionShareRepository } from "../ports/session-share-repository.js";
import type {
  SessionShare,
  ShareRole,
} from "../domain/share.js";
import {
  CannotShareWithSelfError,
  InvalidShareRoleError,
  isShareRole,
  SessionShareId,
} from "../domain/share.js";
import type { SessionId } from "../domain/session.js";

/**
 * "Who can do what with a share":
 *   - Anyone can be granted; only the session owner OR a workspace
 *     admin can grant.
 *
 * The workspace-admin check itself lives outside this service (the
 * routes layer pre-checks via the existing AdminGuard pattern). This
 * file only enforces the owner / shared-with-self / role-validity
 * invariants the domain knows about.
 */

export class NotSessionOwnerError extends DomainError {
  readonly code = "not_session_owner";
  constructor() {
    super("only the session owner or a workspace admin can manage shares");
  }
}

export class SessionNotFoundForShareError extends DomainError {
  readonly code = "session_not_found";
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} not found`);
  }
}

export interface ShareSessionInput {
  sessionId: SessionId;
  /** The user the share is granted TO. */
  granteeUserId: UserId;
  granteeEmail?: Email;
  role: string; // raw string, validated here
  /** The user performing the action. */
  actor: UserId;
  /** True when actor is a workspace admin/owner — bypasses ownership check. */
  actorIsWorkspaceAdmin: boolean;
}

export interface ShareSessionDeps {
  sessions: SessionRepository;
  shares: SessionShareRepository;
}

/**
 * Create or update a share grant. Idempotent on (session, user) — re-
 * sharing updates the role + sharedBy in place.
 */
export async function shareSession(
  deps: ShareSessionDeps,
  input: ShareSessionInput,
): Promise<SessionShare> {
  if (!isShareRole(input.role)) throw new InvalidShareRoleError(input.role);
  const role: ShareRole = input.role;

  const session = await deps.sessions.findById(input.sessionId);
  if (!session) throw new SessionNotFoundForShareError(String(input.sessionId));

  if (
    !input.actorIsWorkspaceAdmin &&
    session.triggeredByUserId !== input.actor
  ) {
    throw new NotSessionOwnerError();
  }

  if (input.granteeUserId === session.triggeredByUserId) {
    throw new CannotShareWithSelfError();
  }

  return deps.shares.upsert({
    sessionId: input.sessionId,
    userId: input.granteeUserId,
    role,
    sharedBy: input.actor,
  });
}

export interface UnshareSessionInput {
  sessionId: SessionId;
  granteeUserId: UserId;
  actor: UserId;
  actorIsWorkspaceAdmin: boolean;
}

export async function unshareSession(
  deps: ShareSessionDeps,
  input: UnshareSessionInput,
): Promise<void> {
  const session = await deps.sessions.findById(input.sessionId);
  if (!session) throw new SessionNotFoundForShareError(String(input.sessionId));

  if (
    !input.actorIsWorkspaceAdmin &&
    session.triggeredByUserId !== input.actor
  ) {
    throw new NotSessionOwnerError();
  }

  await deps.shares.removeForUser(input.sessionId, input.granteeUserId);
}

/** Whether `user` can read this session's events / detail. */
export async function canReadSession(
  deps: ShareSessionDeps,
  sessionId: SessionId,
  userId: UserId,
): Promise<{ ok: true; via: "owner" | "share" } | { ok: false }> {
  const session = await deps.sessions.findById(sessionId);
  if (!session) return { ok: false };
  if (session.triggeredByUserId === userId) return { ok: true, via: "owner" };
  const share = await deps.shares.findForUser(sessionId, userId);
  if (share) return { ok: true, via: "share" };
  return { ok: false };
}

/** Whether `user` can SEND input messages to this session. */
export async function canWriteSession(
  deps: ShareSessionDeps,
  sessionId: SessionId,
  userId: UserId,
): Promise<boolean> {
  const session = await deps.sessions.findById(sessionId);
  if (!session) return false;
  if (session.triggeredByUserId === userId) return true;
  const share = await deps.shares.findForUser(sessionId, userId);
  return share?.role === "collaborator";
}

// Convenience re-export so the routes layer doesn't need a separate import.
export { SessionShareId };
