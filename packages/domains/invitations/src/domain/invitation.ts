import {
  type Email,
  type InvitationId,
  type Role,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  InvitationAlreadyAcceptedError,
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationRevokedError,
} from "./errors.js";

declare const tokenBrand: unique symbol;
export type InvitationToken = string & { readonly [tokenBrand]: true };

export const InvitationToken = (s: string): InvitationToken =>
  s as InvitationToken;

export interface Invitation {
  id: InvitationId;
  workspaceId: WorkspaceId;
  email: Email;
  role: Role;
  token: InvitationToken;
  invitedBy: UserId | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: UserId | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * Verify the domain invariants for an accept attempt. Does NOT mutate —
 * callers apply the outcome through the repository. Pure.
 */
export function canAccept(
  invitation: Invitation,
  attemptingEmail: Email,
  now: Date,
): void {
  if (invitation.acceptedAt) throw new InvitationAlreadyAcceptedError();
  if (invitation.revokedAt) throw new InvitationRevokedError();
  if (invitation.expiresAt.getTime() < now.getTime())
    throw new InvitationExpiredError();
  if (invitation.email !== attemptingEmail) {
    throw new InvitationEmailMismatchError(
      invitation.email,
      attemptingEmail,
    );
  }
}

export function isActive(invitation: Invitation, now: Date): boolean {
  return (
    !invitation.acceptedAt &&
    !invitation.revokedAt &&
    invitation.expiresAt.getTime() >= now.getTime()
  );
}
