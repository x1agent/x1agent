import type { Role, UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * The single side effect invitations applies to the workspaces domain on
 * acceptance. Composition root wires to MembershipRepository.grant.
 */
export interface MembershipGrantor {
  grant(
    workspaceId: WorkspaceId,
    userId: UserId,
    role: Role,
  ): Promise<void>;
}
