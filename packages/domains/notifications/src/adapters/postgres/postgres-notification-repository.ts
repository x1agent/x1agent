import type postgres from "postgres";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import type { Notification } from "../../domain/notification.js";
import type {
  InsertNotificationInput,
  InsertNotificationResult,
  NotificationRepository,
} from "../../ports/notification-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: string;
  source_event_id: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
  read_at: Date | string | null;
}

function toNotification(r: Row): Notification {
  return {
    id: r.id,
    userId: UserId(r.user_id),
    workspaceId: WorkspaceId(r.workspace_id),
    kind: r.kind,
    sourceEventId: r.source_event_id,
    payload: r.payload ?? {},
    createdAt: new Date(r.created_at),
    readAt: r.read_at ? new Date(r.read_at) : null,
  };
}

/**
 * Postgres adapter for `NotificationRepository`. Backed by migration
 * 050's `notifications` table.
 *
 * Idempotency strategy
 * --------------------
 * Uses `INSERT ... ON CONFLICT (user_id, source_event_id) DO NOTHING
 * RETURNING ...`. On collision Postgres returns zero rows — we map
 * that to `{ inserted: false }` so callers don't have to distinguish
 * "first write" from "replay" in a try/catch. Cheaper and racier-safe
 * than an application-side SELECT-then-INSERT (which would hit the
 * unique violation under concurrency and force a retry).
 */
export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly sql: Sql) {}

  async insertIfAbsent(
    input: InsertNotificationInput,
  ): Promise<InsertNotificationResult> {
    const rows = await this.sql<Row[]>`
      INSERT INTO notifications (
        user_id, workspace_id, kind, source_event_id, payload
      ) VALUES (
        ${input.userId},
        ${input.workspaceId},
        ${input.kind},
        ${input.sourceEventId},
        ${this.sql.json(input.payload as never)}
      )
      ON CONFLICT (user_id, source_event_id) DO NOTHING
      RETURNING id, user_id, workspace_id, kind, source_event_id,
                payload, created_at, read_at
    `;

    if (rows.length === 0) return { inserted: false };
    return { inserted: true, notification: toNotification(rows[0]!) };
  }
}
