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
  producingSessionId: SessionId;
  producingAgentId: string;
}

export interface ShareCommentPublisher {
  commentAdded(event: ShareCommentAddedEvent): Promise<void>;
  threadResolved(event: ShareCommentThreadResolvedEvent): Promise<void>;
}
