import type { Clock, UserId } from "@x1agent/kernel";
import type { AgentRepository } from "@x1agent/domain-agents";
import { AgentNotFoundError } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import {
  SessionNotFoundError,
  SessionAlreadyTerminalError,
  type Session,
  type SessionId,
} from "../domain/session.js";
import { isTerminal } from "../domain/status.js";

export interface CancelSessionDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  adminGuard: AdminGuard;
  clock: Clock;
}

/**
 * Cancel a pending or running session. The DB row flips to a terminal
 * `complete` status with `errorMessage: "cancelled"` for audit trail —
 * using `complete` (not `failed`) because user-initiated stop is a
 * clean exit, not an agent crash. If the session is already terminal
 * the call is an error.
 *
 * TODO: when the session is `running`, also terminate the K8s Job
 * driving it. Today the DB row flips but the pod keeps executing
 * until its idle-timeout. The Job watcher should delete the Job when
 * status crosses to terminal so the pod stops on cancel.
 */
export async function cancelSession(
  deps: CancelSessionDeps,
  actor: UserId,
  sessionId: SessionId,
): Promise<Session> {
  const session = await deps.sessions.findById(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);

  const agent = await deps.agents.findById(session.agentId);
  if (!agent) throw new AgentNotFoundError(session.agentId);
  // The user who triggered the session can cancel their own. Anyone
  // else (e.g. an admin stopping someone else's run) must be admin.
  if (session.triggeredByUserId === actor) {
    await deps.adminGuard.assertMember(actor, agent.workspaceId);
  } else {
    await deps.adminGuard.assertAdmin(actor, agent.workspaceId);
  }

  if (isTerminal(session.status)) {
    throw new SessionAlreadyTerminalError(sessionId, session.status);
  }

  return deps.sessions.updateStatus(sessionId, {
    status: "complete",
    completedAt: deps.clock.now(),
    errorMessage: "cancelled",
  });
}
