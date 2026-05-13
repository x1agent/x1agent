import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { Notification, NotificationKind } from "../domain/notification.js";

/**
 * Write-side port. Reads live in X1A-112 and will extend this interface
 * (or add a sibling `NotificationReadRepository`) without breaking the
 * write contract.
 */
export interface NotificationRepository {
  /**
   * Insert one notification row. Idempotent on `(userId, sourceEventId)`
   * via migration 050's unique index — the adapter MUST use
   * `INSERT ... ON CONFLICT DO NOTHING` so a replay never throws and
   * never produces a duplicate row.
   *
   * Returns:
   *   - `{ inserted: true, notification }` on first write.
   *   - `{ inserted: false }` when the same (userId, sourceEventId) pair
   *     was already written. The caller treats this as success — the
   *     row exists, the recipient will see it.
   */
  insertIfAbsent(
    input: InsertNotificationInput,
  ): Promise<InsertNotificationResult>;
}

export interface InsertNotificationInput {
  userId: UserId;
  workspaceId: WorkspaceId;
  kind: NotificationKind | string;
  sourceEventId: string;
  payload: Record<string, unknown>;
}

export type InsertNotificationResult =
  | { inserted: true; notification: Notification }
  | { inserted: false };
