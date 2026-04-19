import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Only admins and owners of a workspace can create, list, or revoke
 * permission grants. Composition root wires this to the workspaces
 * domain's role check.
 */
export interface AdminGuard {
  assertAdmin(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}
