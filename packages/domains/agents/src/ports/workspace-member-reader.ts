import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Narrow port: "is this user a member of this workspace?" Used by
 * use cases that take a foreign userId in their input and need to
 * confirm it's actually scoped to the agent's workspace before
 * accepting it — e.g. scheduled_run_as_user_id, future agent-grant
 * additions.
 *
 * Composition root wires this to the workspaces domain's membership
 * repository. Same pattern as AdminGuard.
 */
export interface WorkspaceMemberReader {
  isMember(workspaceId: WorkspaceId, userId: UserId): Promise<boolean>;
}
