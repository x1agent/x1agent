import type { NotificationRepository } from "../../ports/notification-repository.js";

/**
 * X1A-111 — `comment_reply` subscriber stub.
 *
 * INTENTIONALLY NO-OP in v1. Depends on X1A-110 — share-comment reply
 * parenthood (a `parent_comment_id` column on share_comments). Until
 * that ticket lands, there's no way to distinguish a reply from a
 * top-level comment, and the existing `agent.share_comment_added`
 * event doesn't carry a parent comment id.
 *
 * Composition mounts `register()` so the wiring slot exists. When
 * X1A-110 ships:
 *   1. Either extend the existing `agent.share_comment_added` payload
 *      with `parent_comment_id` (preferred — single subject) or add a
 *      new subject `agent.share_comment_reply_added`. Document the
 *      choice in the ticket and in this file.
 *   2. The handler resolves the parent comment's author via the
 *      `ShareCommentRepository`, derives `sourceEventId` from the new
 *      comment's id, and calls `notifyOnce` with
 *      `kind: "comment_reply"` and recipient = parent author.
 *   3. Self-notify suppression (replier === parent author) is handled
 *      by `notifyOnce` — no need to duplicate the guard here.
 *   4. Use queue group `"notifications-writer"`.
 */
export interface CommentReplySubscriberOptions {
  natsUrl: string;
  notifications: NotificationRepository;
}

export interface CommentReplySubscriberHandle {
  close: () => Promise<void>;
}

export async function startCommentReplySubscriber(
  _opts: CommentReplySubscriberOptions,
): Promise<CommentReplySubscriberHandle> {
  console.log(
    "[notifications-writer] comment_reply subscriber: stub (X1A-110 dependency)",
  );
  return {
    close: async () => {
      // No subscription to drain.
    },
  };
}
