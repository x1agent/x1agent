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

/**
 * Terminates the K8s Job backing a session. Optional dep — installs
 * that wire the job watcher provide it; tests pass a no-op. Errors
 * during termination are logged and swallowed: the DB-side cancel is
 * the source of truth, and the reconciler's "job disappeared" branch
 * picks up any stragglers on the next tick. X1A-70.
 */
export interface JobTerminator {
  terminateForSession(sessionId: SessionId): Promise<void>;
}

export interface CancelSessionDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  adminGuard: AdminGuard;
  clock: Clock;
  /** Optional. When wired, cancel also deletes the K8s Job so the pod stops. */
  jobs?: JobTerminator;
}

/**
 * Cancel a pending or running session. The DB row flips to a terminal
 * `complete` status with `errorMessage: "cancelled"` for audit trail —
 * using `complete` (not `failed`) because user-initiated stop is a
 * clean exit, not an agent crash. If the session is already terminal
 * the call is an error.
 *
 * When the session was running, we ALSO terminate the backing K8s
 * Job so the pod actually stops (X1A-70). Without this, Pause was
 * purely cosmetic — the DB row flipped but the pod kept executing
 * until its idle timeout, burning tokens for nothing. Termination
 * happens AFTER the DB flip so a delete failure can't leave us
 * advertising the session as complete while the pod's still racing
 * to write events; reconciler picks up the straggler on next tick.
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

  const wasRunning = session.status === "running";

  const updated = await deps.sessions.updateStatus(sessionId, {
    status: "complete",
    completedAt: deps.clock.now(),
    errorMessage: "cancelled",
  });

  // Fire-and-log: a K8s API blip must not block the cancel response.
  // Idempotent — the reconciler's "job disappeared" handling treats
  // the gone-Job case as a no-op.
  if (wasRunning && deps.jobs) {
    try {
      await deps.jobs.terminateForSession(sessionId);
    } catch (err) {
      console.warn(
        `[cancel-session] Job terminate failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  return updated;
}
