import type { UserId } from "@x1agent/kernel";
import type { SessionId } from "../domain/session.js";
import type {
  CommentScope,
  PassageAnchor,
  ShareCommentId,
  ShareThreadId,
} from "../domain/share-comment.js";

/**
 * NATS publisher for share-comment lifecycle events.
 *
 * X1A-55 ("agent wake on comment-add — close the two-way loop") is the
 * primary downstream consumer. The wake plumbing CANNOT route without
 * `producingSessionId` + `producingAgentId` — those identify which
 * agent's comment-handler session to spawn when a new comment lands.
 * See PRD-0005 § "Session lifecycle and context reconstruction" for
 * the design rationale.
 *
 * Topic naming (canonical, per X1A-52 ticket body):
 *   - `agent.share_comment_added`
 *   - `agent.share_comment_thread_resolved`
 *
 * Adding `…_edited` / `…_deleted` is permitted but optional — the
 * comment-handler doesn't (yet) need them. The default Postgres + Hono
 * wiring does not emit those today; if you wire them, mirror the
 * `producing_*` requirement.
 */
export interface ShareCommentAddedEvent {
  shareId: string;
  threadId: ShareThreadId;
  commentId: ShareCommentId;
  actorUserId: UserId | null;
  actorSessionId: SessionId | null;
  workspaceId: string;
  sessionId: SessionId;
  shareType: string;
  commentScope: CommentScope;
  anchor: PassageAnchor | null;
  body: string;
  producingSessionId: SessionId;
  producingAgentId: string;
  /**
   * X1A-110 — id of the comment this one replies to. Carried on the
   * wire so the browser's live comment subscriber can render the new
   * row indented under the right parent without waiting for a full
   * REST refresh. `null` for a top-level comment.
   */
  parentCommentId: ShareCommentId | null;
}

export interface ShareCommentThreadResolvedEvent {
  shareId: string;
  threadId: ShareThreadId;
  /** Null when a resolve is reversed. */
  resolvedByUserId: UserId | null;
  workspaceId: string;
  sessionId: SessionId;
  shareType: string;
  /** `true` for a resolve, `false` for a reverse-resolve. */
  resolved: boolean;
  /**
   * Server-stamped time of this transition. Carried so the wake-router
   * can discriminate a resolve → unresolve → re-resolve sequence inside
   * the publisher dedup window — without it, the second resolve would
   * collapse and the orchestrator would miss the transition.
   */
  transitionedAt: Date;
  producingSessionId: SessionId;
  producingAgentId: string;
}

export interface ShareCommentPublisher {
  commentAdded(event: ShareCommentAddedEvent): Promise<void>;
  threadResolved(event: ShareCommentThreadResolvedEvent): Promise<void>;
}
