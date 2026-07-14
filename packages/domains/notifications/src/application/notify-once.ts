import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { Notification, NotificationKind } from "../domain/notification.js";
import type { NotificationRepository } from "../ports/notification-repository.js";

/**
 * X1A-111 application service — `notifyOnce`.
 *
 * The single write entrypoint every subscriber goes through. Wraps the
 * repository's idempotent insert so business invariants (suppress
 * self-notify, drop unknown kinds, etc.) live in one place rather than
 * duplicated across the three subscribers.
 *
 * Self-notify suppression
 * -----------------------
 * Every subscriber computes "the actor who caused this" and "the
 * recipient who should learn about it". If they're equal — author
 * mentions themselves, replier replies to their own comment, share
 * creator was already in the recipient list — we drop the write at
 * this layer rather than push the burden down into each subscriber.
 * Pass `actorUserId` to opt in. Pass `null` (anonymous / agent actor)
 * to skip the check.
 *
 * Idempotency
 * -----------
 * Idempotency is enforced at the DB level via the unique index on
 * `(user_id, source_event_id)` in migration 050. This function does
 * NOT pre-check existence — the `INSERT ... ON CONFLICT DO NOTHING`
 * in the adapter is the canonical guard. Returning `inserted: false`
 * is success, not failure.
 */
export interface NotifyOnceInput {
  /** The user who will see this notification. */
  recipientUserId: UserId;
  /**
   * Set to skip when actor === recipient. Pass `null` when the actor
   * is an agent session (or otherwise non-user), in which case the
   * self-notify guard is a no-op.
   */
  actorUserId: UserId | null;
  workspaceId: WorkspaceId;
  kind: NotificationKind | string;
  /**
   * Stable identifier of the source event — usually the NATS message
   * id, or a deterministic hash of (kind, source-row-id, recipient).
   * Idempotency hinges on this: replays of the same event must use
   * the same value.
   */
  sourceEventId: string;
  payload: Record<string, unknown>;
}

export type NotifyOnceResult =
  | { kind: "written"; notification: Notification }
  | { kind: "duplicate" }
  | { kind: "self_skipped" };

export interface NotifyOnceDeps {
  repository: NotificationRepository;
}

export async function notifyOnce(
  deps: NotifyOnceDeps,
  input: NotifyOnceInput,
): Promise<NotifyOnceResult> {
  if (input.actorUserId && input.actorUserId === input.recipientUserId) {
    return { kind: "self_skipped" };
  }

  const result = await deps.repository.insertIfAbsent({
    userId: input.recipientUserId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    sourceEventId: input.sourceEventId,
    payload: input.payload,
  });

  if (result.inserted) {
    return { kind: "written", notification: result.notification };
  }
  return { kind: "duplicate" };
}
