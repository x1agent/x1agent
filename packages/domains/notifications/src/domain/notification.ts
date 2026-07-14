import { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * X1A-111 — Notification entity.
 *
 * One row per notification-worthy event for one recipient. Created by
 * `notifyOnce` when a producer ticket (X1A-73 mentions, X1A-110 reply
 * parenthood, the share-grant flow) emits an event we care about.
 * This package owns the *write* side only; reads, mark-read and the
 * notification-center UI are X1A-112 / X1A-113.
 *
 * Kinds (v1)
 * ----------
 *   - `comment_mention` — fires when an @-mention lands in a comment.
 *     Source: X1A-73's `share_comment_mentions` insertion path.
 *   - `comment_reply`   — fires when a reply targets a comment with a
 *     different author. Source: X1A-110's reply parenthood.
 *   - `share_grant`     — fires when a user is added as a recipient on
 *     a share. Source: the (TBD) share-grant flow.
 *
 * Kinds are open-ended at the DB level (TEXT, no CHECK) so adding a new
 * kind never needs a migration. The application layer enforces the set.
 *
 * `kind` is intentionally a plain `string` (not a TS enum) so each
 * subscriber owns its kind literal without round-tripping through this
 * package. Validate by the `notificationKindIsKnown` helper below if a
 * write-time guard is desired.
 */
export type NotificationKind =
  | "comment_mention"
  | "comment_reply"
  | "share_grant";

const KNOWN_KINDS = new Set<string>([
  "comment_mention",
  "comment_reply",
  "share_grant",
]);

export function notificationKindIsKnown(
  kind: string,
): kind is NotificationKind {
  return KNOWN_KINDS.has(kind);
}

/**
 * Persisted notification row. Carries the same fields the future read
 * APIs return — defining the entity now keeps the contract stable
 * across the X1A-111 → X1A-112 hand-off.
 */
export interface Notification {
  id: string;
  userId: UserId;
  workspaceId: WorkspaceId;
  kind: NotificationKind | string;
  /**
   * Idempotency key. Stable across replays of the same source event.
   * The writer enforces "one row per (user, source_event_id)" via the
   * unique constraint in migration 050.
   */
  sourceEventId: string;
  /**
   * Kind-specific JSON payload. Shape lives in the subscriber that
   * emits each kind (see `event-payloads.ts`); this package stores it
   * opaquely so adding a new field never crosses the DB layer.
   */
  payload: Record<string, unknown>;
  createdAt: Date;
  /**
   * Filled by the future mark-read endpoint (X1A-112). Always null on
   * insert; this ticket never writes it.
   */
  readAt: Date | null;
}
