import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Same local port shape used by the agents domain. Keeps sessions
 * decoupled from how workspace membership is stored.
 *
 * `assertMember` is the lighter gate used by run-time actions (start
 * a session, cancel one you own) — anyone with a membership row in
 * the workspace passes. `assertAdmin` stays the gate for management
 * (bulk delete, list other people's sessions).
 */
export interface AdminGuard {
  assertAdmin(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
  assertMember(userId: UserId, workspaceId: WorkspaceId): Promise<void>;
}
