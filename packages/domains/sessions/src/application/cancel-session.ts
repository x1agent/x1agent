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
 * Cancel a pending session. Running sessions must be cancelled through the
 * executor — we do not race with a live Kubernetes Job from here. If the
 * session is already terminal the call is an error.
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
  await deps.adminGuard.assertAdmin(actor, agent.workspaceId);

  if (isTerminal(session.status)) {
    throw new SessionAlreadyTerminalError(sessionId, session.status);
  }

  return deps.sessions.updateStatus(sessionId, {
    status: "failed",
    completedAt: deps.clock.now(),
    errorMessage: "cancelled",
  });
}
