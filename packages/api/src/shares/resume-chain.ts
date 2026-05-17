import type {
  SessionId,
  SessionRepository,
} from "@x1agent/domain-sessions";

/**
 * Walk `resumedFromSessionId` upward from `sessionId` and return every
 * session id on the chain, including `sessionId` itself. Most chains
 * are length 1 (no resume) or 2 (one resume); deeper chains are rare.
 *
 * Bounded by `maxDepth` to defend against cycles. Stops on the first
 * findById miss — a deleted ancestor terminates the walk early but
 * doesn't fail the caller.
 *
 * Used by the share-auth checks: a write or read against
 * `share_id = X` whose owner is *any* ancestor in the writing session's
 * chain is allowed. A foreign chain still 403s.
 */
export async function resumeChainSessionIds(
  sessions: SessionRepository,
  sessionId: SessionId,
  maxDepth = 16,
): Promise<string[]> {
  const chain: string[] = [];
  let cursor: SessionId | null = sessionId;
  const seen = new Set<string>();
  for (let i = 0; i < maxDepth && cursor; i++) {
    const id = String(cursor);
    if (seen.has(id)) break;
    seen.add(id);
    chain.push(id);
    const session = await sessions.findById(cursor);
    if (!session) break;
    cursor = session.resumedFromSessionId ?? null;
  }
  return chain;
}
