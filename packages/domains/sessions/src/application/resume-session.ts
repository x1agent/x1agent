import type { Clock, UserId } from "@x1agent/kernel";
import type { AgentRepository } from "@x1agent/domain-agents";
import { AgentNotFoundError } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import {
  SessionAlreadyTerminalError,
  SessionId,
  SessionNotFoundError,
  type Session,
} from "../domain/session.js";
import { DomainError } from "@x1agent/kernel";
import { isTerminal } from "../domain/status.js";

export interface ResumeSessionDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  adminGuard: AdminGuard;
  clock: Clock;
}

export interface ResumeSessionInput {
  actor: UserId;
  originalSessionId: SessionId;
}

export class SessionNotTerminalError extends DomainError {
  readonly code = "session_not_terminal";
  constructor(public readonly id: string) {
    super(`session ${id} is still running; resume requires a terminal state`);
  }
}

/**
 * A user asks to resume a completed/failed session. The new session
 * points at the original via `resumedFromSessionId`; the job-watcher
 * walks that chain at spawn time to build
 * `/workspace/session_history.md` and injects the resume prompt so
 * the agent reads the history before the next user message.
 *
 * The original session stays immutable — resume always creates a new
 * row. This keeps the chain auditable and lets a user resume the same
 * session multiple times into different branches.
 */
export async function resumeSession(
  deps: ResumeSessionDeps,
  input: ResumeSessionInput,
): Promise<Session> {
  const original = await deps.sessions.findById(input.originalSessionId);
  if (!original) throw new SessionNotFoundError(input.originalSessionId);

  if (!isTerminal(original.status)) {
    // Treat "still pending / running" as a soft error — the user
    // should wait or cancel before resuming.
    if (original.status === "pending" || original.status === "running") {
      throw new SessionNotTerminalError(original.id);
    }
    // Any other non-terminal status is a domain bug surfaced here.
    throw new SessionAlreadyTerminalError(original.id, original.status);
  }

  const agent = await deps.agents.findById(original.agentId);
  if (!agent) throw new AgentNotFoundError(original.agentId);

  await deps.adminGuard.assertAdmin(input.actor, agent.workspaceId);

  return deps.sessions.create({
    agentId: agent.id,
    triggeredBy: "user",
    triggeredByUserId: input.actor,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: original.id,
    triggeredAt: deps.clock.now(),
    // Preserve the runtime used by the conversation being resumed. A
    // resume is a new pod, but it should not silently switch runtimes.
    runtimeOverride: original.runtimeOverride ?? null,
  });
}
