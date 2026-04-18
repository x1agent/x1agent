import type { Clock, InvitationId, UserId } from "@x1agent/kernel";
import type { InvitationRepository } from "../ports/invitation-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import {
  InvitationNotFoundError,
  InvitationAlreadyAcceptedError,
  InvitationRevokedError,
} from "../domain/errors.js";

export interface RevokeInvitationDeps {
  invitations: InvitationRepository;
  adminGuard: AdminGuard;
  clock: Clock;
}

export async function revokeInvitation(
  deps: RevokeInvitationDeps,
  actor: UserId,
  invitationId: InvitationId,
): Promise<void> {
  const inv = await deps.invitations.findById(invitationId);
  if (!inv) throw new InvitationNotFoundError();

  await deps.adminGuard.assertAdmin(actor, inv.workspaceId);

  if (inv.acceptedAt) throw new InvitationAlreadyAcceptedError();
  if (inv.revokedAt) throw new InvitationRevokedError();

  await deps.invitations.markRevoked(invitationId, deps.clock.now());
}
