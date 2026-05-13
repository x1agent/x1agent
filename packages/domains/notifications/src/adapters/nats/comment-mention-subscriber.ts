import type { NotificationRepository } from "../../ports/notification-repository.js";

/**
 * X1A-111 — `comment_mention` subscriber stub.
 *
 * INTENTIONALLY NO-OP in v1. The producer side is X1A-73 (@-mention
 * writes to `share_comment_mentions`). Until X1A-73 lands, there is no
 * NATS event to consume — wiring a real subscriber now would either
 * subscribe to a subject nothing publishes on, or force this ticket to
 * also ship the parser and mention-row writes (which is X1A-73's job).
 *
 * Composition mounts `register()` so the wiring slot exists. When
 * X1A-73 ships its mention-write path it must also:
 *   1. Decide the NATS subject (suggested: `agent.share_comment_mention_added`)
 *      and publish payload shape:
 *      ```
 *      {
 *        source_event_id: string,    // dedupe key
 *        mentioned_user_id: string,  // recipient
 *        actor_user_id: string|null, // author (null when agent posted)
 *        workspace_id: string,
 *        comment_id: string,
 *        thread_id: string,
 *        share_id: string,
 *        snippet: string,
 *      }
 *      ```
 *   2. Replace the no-op body below with an `nc.subscribe(...)` loop
 *      that decodes the payload and calls `notifyOnce` with
 *      `kind: "comment_mention"`.
 *   3. Use the queue group `"notifications-writer"` so multi-replica
 *      api processes don't double-write.
 */
export interface CommentMentionSubscriberOptions {
  /**
   * NATS URL. The stub does not connect — when X1A-73 ships the real
   * subscriber it should `connect(natsConnectOpts(natsUrl))` here,
   * matching the existing `startCommentWakeSubscriber` pattern.
   */
  natsUrl: string;
  /** Reserved for the X1A-73 wiring; unused by the v1 no-op. */
  notifications: NotificationRepository;
}

export interface CommentMentionSubscriberHandle {
  close: () => Promise<void>;
}

export async function startCommentMentionSubscriber(
  _opts: CommentMentionSubscriberOptions,
): Promise<CommentMentionSubscriberHandle> {
  // No-op until X1A-73 lands. See header for the wiring contract.
  console.log(
    "[notifications-writer] comment_mention subscriber: stub (X1A-73 dependency)",
  );
  return {
    close: async () => {
      // No subscription to drain.
    },
  };
}
