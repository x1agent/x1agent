import type { Clock } from "@x1agent/kernel";
import type { SessionRepository } from "../ports/session-repository.js";
import type { SessionEventRepository } from "../ports/session-event-repository.js";
import {
  SessionNotFoundError,
  type Session,
  type SessionId,
} from "../domain/session.js";
import { isTerminal } from "../domain/status.js";
import type { JobTerminator } from "./cancel-session.js";
import { appendSessionEvent } from "./append-session-event.js";

/**
 * The caller's session has no parent relationship to the named child.
 * Surfaced to the agent so the SDK can emit a clean tool error instead
 * of leaking the underlying repository state.
 */
export class NotYourChildError extends Error {
  readonly code = "not_your_child" as const;
  constructor(childSessionId: SessionId, claimedParentId: SessionId) {
    super(
      `Session ${claimedParentId} is not the parent of session ${childSessionId}`,
    );
  }
}

export interface CancelChildSessionDeps {
  sessions: SessionRepository;
  events: SessionEventRepository;
  clock: Clock;
  /** Optional. When wired, cancel also deletes the K8s Job so the pod stops. */
  jobs?: JobTerminator;
}

export interface CancelChildSessionResult {
  session: Session;
  /** False when the child was already terminal — the call is a no-op. */
  cancelled: boolean;
}

/**
 * Parent-initiated cancel of a child session (X1A-118).
 *
 * Distinct from `cancelSession` (the human-initiated, admin-guarded
 * cancel) on three axes:
 *
 *   1. Authorization is the parent → child relationship, not a user
 *      ACL. The caller's session id must match the child's
 *      `parent_session_id`. No admin-guard check.
 *   2. Idempotent: a second call on an already-terminal session
 *      returns `cancelled: false` instead of throwing. The orchestrator
 *      may legitimately race state-change wakes and emit cancel after
 *      the child completed on its own.
 *   3. Emits a `session.cancelled_by_parent` event for audit so the
 *      timeline distinguishes parent-driven termination from a worker
 *      that finished cleanly.
 *
 * The K8s Job termination + DB flip path is shared with `cancelSession`
 * so a Pause from the UI and a `cancel_session` MCP call from an
 * orchestrator leave the cluster in the same shape.
 */
export async function cancelChildSession(
  deps: CancelChildSessionDeps,
  callerSessionId: SessionId,
  childSessionId: SessionId,
  reason: string | null,
): Promise<CancelChildSessionResult> {
  const child = await deps.sessions.findById(childSessionId);
  if (!child) throw new SessionNotFoundError(childSessionId);
  if (child.parentSessionId !== callerSessionId) {
    throw new NotYourChildError(childSessionId, callerSessionId);
  }

  if (isTerminal(child.status)) {
    return { session: child, cancelled: false };
  }

  const wasRunning = child.status === "running";
  const updated = await deps.sessions.updateStatus(childSessionId, {
    status: "complete",
    completedAt: deps.clock.now(),
    errorMessage: "cancelled_by_parent",
  });

  // Audit event so the timeline shows who cancelled and why. The seq
  // counter for live sessions is the sidecar's per-session atomic;
  // here we're writing from the api process so we need a value that
  // can't collide with the sidecar's in-flight increments. A wall-clock
  // epoch-ms is monotonic per process, much larger than any session's
  // sidecar counter (millions before clash), and sorts to the end of
  // the timeline — exactly where a termination event belongs.
  // Collisions on the same ms are absorbed by appendSessionEvent's
  // duplicate handling (returns null, doesn't throw).
  try {
    await appendSessionEvent(
      { events: deps.events },
      {
        sessionId: childSessionId,
        seq: deps.clock.now().getTime(),
        type: "session.cancelled_by_parent",
        payload: {
          parent_session_id: callerSessionId,
          reason: reason ?? null,
        },
        timestamp: deps.clock.now(),
      },
    );
  } catch (err) {
    console.warn(
      `[cancel-child-session] event emit failed for ${childSessionId}: ${(err as Error).message}`,
    );
  }

  if (wasRunning && deps.jobs) {
    try {
      await deps.jobs.terminateForSession(childSessionId);
    } catch (err) {
      console.warn(
        `[cancel-child-session] Job terminate failed for ${childSessionId}: ${(err as Error).message}`,
      );
    }
  }

  return { session: updated, cancelled: true };
}
