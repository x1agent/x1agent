import { randomUUID } from "node:crypto";
import type { UserId } from "@x1agent/kernel";
import type { SessionId } from "../domain/session.js";
import {
  ShareThreadId,
  assertValidCommentInput,
  type CommentScope,
  type PassageAnchor,
  type ShareComment,
} from "../domain/share-comment.js";
import type { ShareCommentRepository } from "../ports/share-comment-repository.js";
import type { ShareCommentPublisher } from "../ports/share-comment-publisher.js";

/**
 * Application use-case: post a comment to a share, opening a new
 * thread if `threadId` is omitted. All business invariants live here
 * — anchor/scope coherence, share-type compatibility, body bounds —
 * so every adapter (Hono route, MCP tool, future internal callers)
 * is forced through the same gate.
 *
 * The IDOR check (does the caller see the share?) lives in the route
 * layer because it depends on Postgres state outside this domain
 * (workspace memberships, session_user_shares). This function trusts
 * its `workspaceId` + `sessionId` inputs as already-authorised.
 */
export interface PostShareCommentInput {
  /** Resolved from URL + share-event lookup, NOT from request body. */
  sessionId: SessionId;
  /** Resolved from the session's agent.workspace_id. */
  workspaceId: string;
  shareId: string;
  /** Detected from the agent.share event payload. */
  shareType: string;

  /** Opens a new thread when omitted; replies when present. */
  threadId?: ShareThreadId;
  scope: CommentScope;
  anchor: PassageAnchor | null;
  body: string;

  /** Exactly one of these is non-null. */
  authorUserId: UserId | null;
  authorSessionId: SessionId | null;
}

export interface PostShareCommentDeps {
  comments: ShareCommentRepository;
  publisher: ShareCommentPublisher;
  /**
   * The session that originally produced the share. Almost always
   * `input.sessionId`, but split so the wake plumbing on X1A-55 can
   * subscribe to the right producing session.
   */
  resolveProducingContext: (
    sessionId: SessionId,
  ) => Promise<{ producingSessionId: SessionId; producingAgentId: string }>;
}

export interface PostShareCommentResult {
  comment: ShareComment;
  threadId: ShareThreadId;
}

export async function postShareComment(
  deps: PostShareCommentDeps,
  input: PostShareCommentInput,
): Promise<PostShareCommentResult> {
  assertValidCommentInput({
    body: input.body,
    scope: input.scope,
    anchor: input.anchor,
    shareType: input.shareType,
  });

  const threadId = input.threadId ?? ShareThreadId(randomUUID());

  const comment = await deps.comments.append({
    shareId: input.shareId,
    threadId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    shareType: input.shareType,
    commentScope: input.scope,
    anchorJson: input.anchor,
    body: input.body,
    authorUserId: input.authorUserId,
    authorSessionId: input.authorSessionId,
  });

  // Emit the NATS event AFTER the row commits. X1A-55's wake plumbing
  // reads `producing_session_id` + `producing_agent_id` from this
  // payload to know which agent to (re)spawn — see PRD-0005
  // § "Session lifecycle and context reconstruction."
  const producing = await deps.resolveProducingContext(input.sessionId);
  await deps.publisher.commentAdded({
    shareId: input.shareId,
    threadId,
    commentId: comment.id,
    actorUserId: input.authorUserId,
    actorSessionId: input.authorSessionId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    shareType: input.shareType,
    commentScope: input.scope,
    anchor: input.anchor,
    body: input.body,
    producingSessionId: producing.producingSessionId,
    producingAgentId: producing.producingAgentId,
  });

  return { comment, threadId };
}
