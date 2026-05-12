import type { SessionId } from "../domain/session.js";
import {
  ShareNotFoundError,
  ShareThreadId,
  ThreadNotFoundError,
  ThreadNotVisibleError,
} from "../domain/share-comment.js";
import type { ShareCommentRepository } from "../ports/share-comment-repository.js";

/**
 * IDOR guard for thread-scoped operations.
 *
 * `share_comment(thread_id, …)` — and any other route that takes a bare
 * thread_id from the client — MUST run the supplied id through this
 * function before doing anything else with it. The CEO requirement
 * (X1A-52 comment, 2026-05-11): "A malicious / careless prompt could
 * inject a `thread_id` from an unrelated workspace and the agent would
 * obediently leak content otherwise."
 *
 * Steps:
 *   1. Find the thread row → derive (session_id, share_id, workspace_id).
 *   2. Verify the actor can see that session via the supplied predicate
 *      (workspace member OR session_user_shares grantee — implemented
 *      in the route layer, passed in here as a closure).
 *   3. Optionally verify the resolved share_id matches what the caller
 *      claimed (defence in depth — catches `thread_id from share A,
 *      share_id from share B` mix-ups).
 *
 * Returns the resolved `share_id` + `session_id` so the caller doesn't
 * re-query.
 */
export interface ResolveShareThreadDeps {
  comments: ShareCommentRepository;
  canSeeSession: (sessionId: SessionId) => Promise<boolean>;
}

export interface ResolveShareThreadResult {
  shareId: string;
  sessionId: SessionId;
  workspaceId: string;
  shareType: string;
  resolvedAt: Date | null;
}

export async function resolveShareThread(
  deps: ResolveShareThreadDeps,
  threadId: ShareThreadId,
  expectedShareId?: string,
): Promise<ResolveShareThreadResult> {
  const t = await deps.comments.findThread(threadId);
  if (!t) throw new ThreadNotFoundError(threadId);

  if (expectedShareId && expectedShareId !== t.shareId) {
    // The caller passed both a thread_id AND an unrelated share_id.
    // Don't leak which one is wrong — treat as not-visible.
    throw new ThreadNotVisibleError();
  }

  const visible = await deps.canSeeSession(t.sessionId);
  if (!visible) throw new ThreadNotVisibleError();

  return {
    shareId: t.shareId,
    sessionId: t.sessionId,
    workspaceId: t.workspaceId,
    shareType: t.shareType,
    resolvedAt: t.resolvedAt,
  };
}

/**
 * Bare-`share_id` path companion. Resolves `(sessionId, shareId)` to a
 * commentable share, looking up the share-type from the underlying
 * `agent.share` event. The caller has already authorised the session
 * via `canSeeSession`; we only need to confirm the share exists in
 * that session and read its type.
 *
 * The `findShareEvent` closure does the join — kept abstract so the
 * use-case stays unit-testable without a postgres connection.
 */
export interface ResolveShareDeps {
  findShareEvent: (
    sessionId: SessionId,
    shareId: string,
  ) => Promise<{ shareType: string } | null>;
}

export async function resolveShare(
  deps: ResolveShareDeps,
  sessionId: SessionId,
  shareId: string,
): Promise<{ shareType: string }> {
  const evt = await deps.findShareEvent(sessionId, shareId);
  if (!evt) throw new ShareNotFoundError();
  return evt;
}
