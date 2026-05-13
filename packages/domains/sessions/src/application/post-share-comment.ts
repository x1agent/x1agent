import { randomUUID } from "node:crypto";
import type { UserId } from "@x1agent/kernel";
import type { SessionId } from "../domain/session.js";
import {
  NestedReplyNotSupportedError,
  ParentCommentNotInThreadError,
  ShareCommentId,
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

  /**
   * X1A-110 — id of the comment this one replies to. `null` for a
   * top-level comment. Application invariants enforced here:
   *   1. The parent must live in the SAME thread as this comment
   *      (the route + this function pass the same threadId; we
   *      double-check by looking the parent up).
   *   2. Depth-1 cap: the parent's own `parentCommentId` MUST be
   *      `null`. v1 forbids reply-to-reply.
   *   3. `parentCommentId` requires `threadId` to be set — you
   *      cannot reply-to-a-comment while opening a NEW thread.
   */
  parentCommentId?: ShareCommentId | null;
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

  // X1A-110 — reply-nesting invariants. Run BEFORE the insert so a
  // malformed reply doesn't leave a stray row behind.
  //
  // Rule 1: replying-to-a-comment requires the reply to live in an
  // existing thread. You can't open a fresh thread AND reply to a
  // comment in the same call — that's a contradiction in terms.
  //
  // Rule 2: parent must exist and be in the SAME thread as the reply
  // (cross-thread parents are a footgun — the parent might be
  // resolved, or in a different anchor, or the reply might end up
  // attributed to the wrong conversation).
  //
  // Rule 3: depth-1 cap. The parent's own parent must be null. v1
  // intentionally avoids deep nesting to keep the sidebar readable
  // on narrow viewports; the schema can carry deeper references once
  // we have a real design for them.
  const parentCommentId = input.parentCommentId ?? null;
  if (parentCommentId !== null) {
    if (!input.threadId) {
      // Replying requires a thread; a brand-new thread has no parent.
      throw new ParentCommentNotInThreadError();
    }
    const parent = await deps.comments.findById(parentCommentId);
    if (!parent) throw new ParentCommentNotInThreadError();
    if (parent.threadId !== threadId) {
      throw new ParentCommentNotInThreadError();
    }
    if (parent.parentCommentId !== null) {
      throw new NestedReplyNotSupportedError();
    }
  }

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
    parentCommentId,
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
    parentCommentId,
  });

  return { comment, threadId };
}
