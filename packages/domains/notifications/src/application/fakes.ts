import { randomUUID } from "node:crypto";
import type { Notification } from "../domain/notification.js";
import type {
  InsertNotificationInput,
  InsertNotificationResult,
  NotificationRepository,
} from "../ports/notification-repository.js";

/**
 * In-memory NotificationRepository used by application-layer unit
 * tests and by composition smoke runs that don't want to touch a real
 * database. Mirrors the Postgres adapter's idempotency semantics — a
 * second insert with the same `(userId, sourceEventId)` returns
 * `{ inserted: false }` and does NOT throw.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly rows: Notification[] = [];

  async insertIfAbsent(
    input: InsertNotificationInput,
  ): Promise<InsertNotificationResult> {
    const existing = this.rows.find(
      (r) => r.userId === input.userId && r.sourceEventId === input.sourceEventId,
    );
    if (existing) return { inserted: false };

    const notification: Notification = {
      id: randomUUID(),
      userId: input.userId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      sourceEventId: input.sourceEventId,
      payload: input.payload,
      createdAt: new Date(),
      readAt: null,
    };
    this.rows.push(notification);
    return { inserted: true, notification };
  }

  /** Test-only inspector. */
  all(): readonly Notification[] {
    return this.rows;
  }
}
