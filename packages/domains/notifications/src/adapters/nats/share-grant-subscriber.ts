import type { NotificationRepository } from "../../ports/notification-repository.js";

/**
 * X1A-111 — `share_grant` subscriber stub.
 *
 * INTENTIONALLY NO-OP in v1. There is no share-grant event on the bus
 * today; shares are derived from `session_events` of type
 * `agent.share` and recipients are implicit (the session's workspace
 * members). The grant model + its NATS event are scoped to a separate
 * future ticket (call it X1A-share-grants — not yet filed).
 *
 * Composition mounts `register()` so the wiring slot exists. When the
 * share-grant flow lands:
 *   1. Define a NATS subject (suggested: `agent.share_recipient_added`)
 *      with payload `{ source_event_id, share_id, recipient_user_id,
 *      granted_by_user_id, workspace_id, title }`.
 *   2. Replace the no-op below with a subscribe loop that calls
 *      `notifyOnce` with `kind: "share_grant"`, recipient =
 *      `recipient_user_id`, actor = `granted_by_user_id`.
 *   3. Self-grant suppression is handled by `notifyOnce`.
 *   4. Use queue group `"notifications-writer"`.
 */
export interface ShareGrantSubscriberOptions {
  natsUrl: string;
  notifications: NotificationRepository;
}

export interface ShareGrantSubscriberHandle {
  close: () => Promise<void>;
}

export async function startShareGrantSubscriber(
  _opts: ShareGrantSubscriberOptions,
): Promise<ShareGrantSubscriberHandle> {
  console.log(
    "[notifications-writer] share_grant subscriber: stub (share-grant flow dependency)",
  );
  return {
    close: async () => {
      // No subscription to drain.
    },
  };
}
