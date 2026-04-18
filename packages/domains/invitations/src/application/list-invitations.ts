import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { InvitationRepository } from "../ports/invitation-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { Invitation } from "../domain/invitation.js";

export interface ListInvitationsDeps {
  invitations: InvitationRepository;
  adminGuard: AdminGuard;
}

export async function listInvitations(
  deps: ListInvitationsDeps,
  actor: UserId,
  workspaceId: WorkspaceId,
): Promise<readonly Invitation[]> {
  await deps.adminGuard.assertAdmin(actor, workspaceId);
  return deps.invitations.listByWorkspace(workspaceId);
}
