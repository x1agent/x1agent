import type { InvitationId, Role, UserId } from "@x1agent/kernel";
import type { InvitationRepository } from "../ports/invitation-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import {
  type Invitation,
} from "../domain/invitation.js";
import {
  InvitationNotFoundError,
  InvitationAlreadyAcceptedError,
  InvitationRevokedError,
} from "../domain/errors.js";

export interface ChangeInvitationRoleDeps {
  invitations: InvitationRepository;
  adminGuard: AdminGuard;
}

/**
 * Edit the role on a still-active invitation. Lets an admin fix a
 * mistyped role in-place instead of doing the revoke-and-re-invite
 * dance (which leaves a clutter `revoked` row behind forever).
 *
 * Idempotent: if the new role equals the current role, the row is
 * unchanged and returned as-is.
 *
 * Refuses to edit an invitation that has already been accepted or
 * revoked — at that point the membership row (or the absence of
 * one) is the source of truth, not the invitation.
 */
export async function changeInvitationRole(
  deps: ChangeInvitationRoleDeps,
  actor: UserId,
  invitationId: InvitationId,
  nextRole: Role,
): Promise<Invitation> {
  const inv = await deps.invitations.findById(invitationId);
  if (!inv) throw new InvitationNotFoundError();

  await deps.adminGuard.assertAdmin(actor, inv.workspaceId);

  if (inv.acceptedAt) throw new InvitationAlreadyAcceptedError();
  if (inv.revokedAt) throw new InvitationRevokedError();

  if (inv.role === nextRole) return inv;
  return deps.invitations.updateRole(invitationId, nextRole);
}
