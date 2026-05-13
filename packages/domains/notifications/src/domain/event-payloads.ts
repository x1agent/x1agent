import type { UserId, WorkspaceId } from "@x1agent/kernel";

/**
 * Kind-specific payload shapes for v1. These are write-side contracts
 * the three subscribers (X1A-73 → comment_mention, X1A-110 →
 * comment_reply, share-grant flow → share_grant) populate when they
 * call `notifyOnce`. Reads in X1A-112 will deserialize these same
 * shapes — keep them stable.
 *
 * Adding a new kind: append a new variant + a new payload type, then
 * update the union in `NotificationPayloadFor`. The DB enforces no
 * shape so the migration burden is zero.
 */

export interface CommentMentionPayload {
  comment_id: string;
  thread_id: string;
  share_id: string;
  /** Null when an agent session authored the comment. */
  actor_user_id: UserId | null;
  /** Short body excerpt for the UI; producer chooses the slice. */
  snippet: string;
}

export interface CommentReplyPayload {
  comment_id: string;
  thread_id: string;
  share_id: string;
  parent_comment_id: string;
  actor_user_id: UserId | null;
  snippet: string;
}

export interface ShareGrantPayload {
  share_id: string;
  granted_by_user_id: UserId;
  workspace_id: WorkspaceId;
  /** Optional share title for the UI. */
  title: string | null;
}

export type NotificationPayloadFor<K extends string> =
  K extends "comment_mention"
    ? CommentMentionPayload
    : K extends "comment_reply"
      ? CommentReplyPayload
      : K extends "share_grant"
        ? ShareGrantPayload
        : Record<string, unknown>;
