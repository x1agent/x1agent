import type { UserId } from "@x1agent/kernel";
import type { SessionId } from "../domain/session.js";
import type {
  CommentScope,
  PassageAnchor,
  ShareComment,
  ShareCommentId,
  ShareThreadId,
} from "../domain/share-comment.js";

/**
 * Persistence port for `share_comments`. The append path picks `seq`
 * with `coalesce(max(seq), 0) + 1` under the unique index on
 * (share_id, thread_id, seq); concurrent appends collide on the unique
 * constraint and the adapter retries up to N times.
 */
export interface AppendShareCommentInput {
  shareId: string;
  threadId: ShareThreadId;
  sessionId: SessionId;
  workspaceId: string;
  shareType: string;
  commentScope: CommentScope;
  anchorJson: PassageAnchor | null;
  body: string;
  authorUserId: UserId | null;
  authorSessionId: SessionId | null;
  /**
   * X1A-110 — id of the comment this one replies to. `null` for a
   * top-level comment (the thread root). The application layer is
   * responsible for enforcing the depth-1 cap and the same-thread
   * invariant before calling `append`; the repository just persists.
   */
  parentCommentId: ShareCommentId | null;
}

/**
 * Minimum row returned by `findThread` — used by the IDOR resolver in
 * the routes layer to bridge `thread_id` back to its owning share.
 */
export interface ThreadLocator {
  shareId: string;
  sessionId: SessionId;
  workspaceId: string;
  shareType: string;
  resolvedAt: Date | null;
  resolvedByUserId: UserId | null;
  firstSeq: number;
}

export interface ShareCommentRepository {
  append(input: AppendShareCommentInput): Promise<ShareComment>;

  /**
   * Comments on a single share, ordered by `(thread_id, seq)`.
   *
   * Without options, returns every row — same shape as before
   * pagination existed. The agent-side reads (NATS subscribers,
   * comment-handler spawn) still need the full window.
   *
   * For the operator-facing sidebar (X1A-72.4), pagination is
   * thread-level:
   *   - `threadLimit`: return comments belonging to the latest N
   *     threads, ordered by the thread's first comment `created_at`
   *     DESC. Within each returned thread, all replies are included.
   *   - `beforeThreadFirstCreatedAt`: only consider threads whose
   *     first comment `created_at` is strictly less than this value.
   *     Pass the earliest head `created_at` from the currently-loaded
   *     window to fetch the preceding page.
   *
   * NOTE: `seq` cannot be used as a cross-thread cursor — it's scoped
   * per `(share_id, thread_id)` in the schema, so every thread's head
   * has seq=1 and any min(seq) cursor degenerates to 1, leaving the
   * server with no eligible older threads.
   */
  listByShare(
    sessionId: SessionId,
    shareId: string,
    opts?: { threadLimit?: number; beforeThreadFirstCreatedAt?: Date },
  ): Promise<readonly ShareComment[]>;

  /**
   * Lookup the share that owns a thread. Returns `null` when no row
   * matches — i.e. the thread does not exist. Used as the first step
   * of the IDOR check on `share_comment(thread_id, …)`.
   */
  findThread(threadId: ShareThreadId): Promise<ThreadLocator | null>;

  /** Fetch one comment by `(shareId, threadId, seq)`. */
  findOne(
    shareId: string,
    threadId: ShareThreadId,
    seq: number,
  ): Promise<ShareComment | null>;

  /**
   * X1A-110 — fetch one comment by its surrogate id. Used by the
   * reply-validation path: given `parent_comment_id`, confirm the
   * parent exists in the same thread AND is itself top-level.
   */
  findById(id: ShareCommentId): Promise<ShareComment | null>;

  /** Edit body of an existing comment. anchor + scope are immutable. */
  updateBody(
    id: ShareCommentId,
    body: string,
  ): Promise<ShareComment | null>;

  /** Hard-delete one comment row. Idempotent — returns true if a row was removed. */
  remove(id: ShareCommentId): Promise<boolean>;

  /**
   * Resolve a thread. Per-thread state is materialised on EVERY row in
   * the thread (so listing can answer "is this resolved" without an
   * extra query); the application sets `resolved_at` on the head comment
   * and the adapter fans the value across the thread's rows.
   */
  setResolved(
    threadId: ShareThreadId,
    resolvedBy: UserId | null,
    resolvedAt: Date | null,
  ): Promise<void>;

  /** "Has this share got any threads at all" — for the inline pill count. */
  countThreadsByShare(
    sessionId: SessionId,
    shareId: string,
  ): Promise<number>;
}
