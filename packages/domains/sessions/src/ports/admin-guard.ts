import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Same local port shape used by the agents domain. Keeps sessions
 * decoupled from how workspace membership is stored.
 */
export interface AdminGuard {
  assertAdmin(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}
