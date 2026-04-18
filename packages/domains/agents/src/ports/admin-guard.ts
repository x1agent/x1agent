import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Local narrow port: "is this user an admin of this workspace?" The
 * composition root wires this to the workspaces domain's role check.
 * Keeps agents decoupled from workspaces' implementation.
 */
export interface AdminGuard {
  assertAdmin(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}
