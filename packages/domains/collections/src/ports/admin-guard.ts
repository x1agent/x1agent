import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Managing collections is admin-only: create, update, delete, attach
 * to an agent. Read access uses the generic membership check that the
 * api middleware already enforces before hitting this domain.
 */
export interface AdminGuard {
  assertAdmin(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}
