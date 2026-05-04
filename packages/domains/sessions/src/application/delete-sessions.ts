import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentRepository } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import { type SessionId } from "../domain/session.js";

export interface DeleteSessionsDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  adminGuard: AdminGuard;
}

export interface DeleteSessionsResult {
  /** Sessions actually removed. */
  deleted: SessionId[];
  /** Sessions skipped because they don't exist or aren't in this workspace. */
  notFound: SessionId[];
}

/**
 * Bulk-delete sessions in one workspace. Workspace admins/owners only —
 * the operator is taking responsibility for purging history. Children
 * (agent-spawned sub-sessions), events, token-usage rows, and shares
 * cascade away via FKs.
 *
 * The delete is row-by-row rather than one big DELETE because we have
 * to verify each session belongs to the caller's workspace; a malicious
 * caller submitting other-workspace ids should not be able to use a
 * single workspace-scoped admin grant to nuke another workspace's
 * sessions.
 */
export async function deleteSessions(
  deps: DeleteSessionsDeps,
  actor: UserId,
  workspaceId: WorkspaceId,
  sessionIds: readonly SessionId[],
): Promise<DeleteSessionsResult> {
  await deps.adminGuard.assertAdmin(actor, workspaceId);

  const deleted: SessionId[] = [];
  const notFound: SessionId[] = [];
  for (const id of sessionIds) {
    const session = await deps.sessions.findById(id);
    if (!session) {
      notFound.push(id);
      continue;
    }
    const agent = await deps.agents.findById(session.agentId);
    if (!agent || (agent.workspaceId as unknown) !== (workspaceId as unknown)) {
      // Cross-workspace id smuggled in — refuse silently as not-found.
      notFound.push(id);
      continue;
    }
    const ok = await deps.sessions.delete(id);
    if (ok) deleted.push(id);
    else notFound.push(id);
  }
  return { deleted, notFound };
}
