import type { Session, SessionId } from "../domain/session.js";
import type { Clock } from "@x1agent/kernel";
import type { SessionRepository } from "../ports/session-repository.js";

/**
 * Checks whether a K8s Job backing a session still exists in the
 * cluster. Returning `false` is the signal to flip the session to
 * `failed` — the Job was never created, was reaped, or the node went
 * away without emitting a terminal Job event.
 *
 * Kept narrow on purpose: the reconciler isn't allowed to know about
 * kube types. The api wires this to a client call that returns
 * (404 → false; otherwise → true). Any transport-level failure
 * (apiserver down, auth, etc.) should propagate so the reconciler
 * skips this tick — never "flip to failed on network blip."
 */
export type JobExistsFn = (sessionId: SessionId) => Promise<boolean>;

/**
 * Called after the reconciler flips a ghost session to `failed`. In
 * production this is `publishStateChangeWake` so the parent
 * orchestrator gets a wake injected; in tests it's a recording
 * function that asserts the call shape. Returning an error from this
 * fn MUST NOT abort the tick — one bad wake shouldn't block the rest
 * of the reap list.
 */
export type StateChangeNotifier = (
  session: Session,
  completedAt: Date,
  errorMessage: string,
) => Promise<void>;

export interface ReconcilerDeps {
  sessions: SessionRepository;
  clock: Clock;
  jobExists: JobExistsFn;
  notify: StateChangeNotifier;
  /**
   * Grace window between `triggered_at` and `now` before a
   * non-terminal session is eligible for reaping. Protects races
   * against the Job-creation path — a session row inserted seconds
   * ago may not yet have its Job applied. 120s is conservative; real
   * Job creation is <5s in happy path, but image pulls can stretch.
   */
  gracePeriodMs: number;
}

export interface ReconcileResult {
  /** Sessions evaluated this tick. */
  checked: number;
  /** Sessions flipped from non-terminal to `failed`. */
  flipped: number;
  /** Skipped because `jobExists` threw — counted for observability. */
  errors: number;
}

const FAIL_MESSAGE =
  "pod_reconciler: no Job found in cluster — likely node restart, kubelet crash, or Job reap without terminal event";

/**
 * Session-status reconciler. Complements the Job-watcher, which is
 * authoritative when the cluster is healthy. This reconciler exists
 * for the case where Job events were lost — crashes, etcd hiccups,
 * missed watches — leaving the DB with `status='running'` rows that
 * no longer have backing pods.
 *
 * For every non-terminal session older than the grace window, asks
 * whether a K8s Job with the canonical `x1-session-<short-id>` name
 * still exists. If no, flips the session to `failed` and publishes a
 * `state_change` wake so any orchestrator parent gets unstuck. If
 * yes, leaves it alone.
 *
 * Idempotent: repeated runs on already-terminal rows are no-ops
 * because `listNonTerminalOlderThan` filters them out. Safe to run
 * concurrently with the Job-watcher — both use
 * `UPDATE ... WHERE status='running'` semantics and converge to the
 * same terminal state.
 */
export async function reconcileSessionStatuses(
  deps: ReconcilerDeps,
): Promise<ReconcileResult> {
  const now = deps.clock.now();
  const threshold = new Date(now.getTime() - deps.gracePeriodMs);
  const stale = await deps.sessions.listNonTerminalOlderThan(threshold);

  let flipped = 0;
  let errors = 0;

  for (const session of stale) {
    let exists: boolean;
    try {
      exists = await deps.jobExists(session.id);
    } catch {
      errors++;
      continue;
    }
    if (exists) continue;

    const completedAt = now;
    const updated = await deps.sessions.updateStatus(session.id, {
      status: "failed",
      completedAt,
      errorMessage: FAIL_MESSAGE,
    });
    flipped++;

    try {
      await deps.notify(updated, completedAt, FAIL_MESSAGE);
    } catch {
      // Wake is best-effort: the DB flip already happened and the
      // orchestrator's next heartbeat will pick up the change.
    }
  }

  return { checked: stale.length, flipped, errors };
}
