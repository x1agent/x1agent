import type postgres from "postgres";
import type { NatsConnection } from "nats";
import type { AgentRepository, AgentId } from "@x1agent/domain-agents";
import { isOrchestratorKind } from "@x1agent/domain-agents";
import { publishWatchdogWake } from "./wake-publisher.js";
import type { QuietHintStore } from "./quiet-hints.js";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Activity watchdog. Periodically sweeps for children whose parent
 * is a live orchestrator and whose session_events stream has been
 * silent past the configured threshold. Publishes a `watchdog` wake
 * to the parent when the child is overdue, with per-child
 * exponential backoff so a genuinely stuck child doesn't generate
 * wake spam.
 *
 * Backoff ladder (minutes of silence before the next wake):
 *   attempt 1:  3
 *   attempt 2:  5
 *   attempt 3: 10
 *   attempt 4: 15
 *   attempt 5+: 20 (cap)
 *
 * Counter resets to attempt 1 whenever we observe new activity from
 * the child. State is per-api-process (in-memory); if the api
 * restarts, the next sweep starts from attempt 1, which is safe —
 * worst case the parent gets one extra wake it would have otherwise
 * skipped.
 *
 * See docs/architecture/orchestration.md § Server-driven wakes.
 */
export interface ActivityWatchdogConfig {
  sql: Sql;
  agents: AgentRepository;
  nc: NatsConnection;
  /**
   * Optional store of child-emitted "expect quiet for N seconds"
   * hints. When a hint is active for a child, the watchdog skips
   * that child on the current sweep — the child asked us to wait.
   * When absent, the watchdog runs without the hint short-circuit.
   */
  quietHints?: QuietHintStore;
  /** Poll interval in ms. Defaults to 60s. */
  intervalMs?: number;
  /** Called on fatal per-tick errors. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

export interface ActivityWatchdogHandle {
  stop: () => Promise<void>;
}

/**
 * Minutes of silence at each attempt. Index into this array with
 * clamp(attempt - 1, 0, BACKOFF_MINUTES.length - 1).
 */
const BACKOFF_MINUTES = [3, 5, 10, 15, 20] as const;

function thresholdSecondsForAttempt(attempt: number): number {
  const idx = Math.min(
    Math.max(attempt - 1, 0),
    BACKOFF_MINUTES.length - 1,
  );
  return BACKOFF_MINUTES[idx]! * 60;
}

interface WatchdogState {
  attempt: number;
  lastObservedActivity: Date;
}

interface SilentCandidateRow {
  child_id: string;
  child_agent_id: string;
  parent_session_id: string;
  last_activity: Date | string;
}

export function startActivityWatchdog(
  cfg: ActivityWatchdogConfig,
): ActivityWatchdogHandle {
  const intervalMs = cfg.intervalMs ?? 60_000;
  const onError =
    cfg.onError ??
    ((err) =>
      console.warn(
        "[watchdog] tick failed:",
        (err as Error).message,
      ));

  // In-memory per-child state. Keyed by child session id. Cleaned up
  // opportunistically — we remove entries for children that are no
  // longer in the candidate set (terminated, orphaned, or parent
  // died).
  const state = new Map<string, WatchdogState>();

  let running = true;
  let ticking = false;

  const tick = async () => {
    if (!running || ticking) return;
    ticking = true;
    try {
      // Pull every child whose session is still open and who has an
      // orchestrator parent also still open. COALESCE the last-event
      // timestamp with the session's triggered_at so a child that
      // emitted zero events still has a silence baseline.
      const now = new Date();
      const rows = await cfg.sql<SilentCandidateRow[]>`
        SELECT
          s.id AS child_id,
          s.agent_id AS child_agent_id,
          s.parent_session_id,
          COALESCE(MAX(e.timestamp), s.triggered_at) AS last_activity
        FROM sessions s
        JOIN sessions p ON p.id = s.parent_session_id
        LEFT JOIN session_events e ON e.session_id = s.id
        WHERE s.status IN ('pending', 'running')
          AND s.parent_session_id IS NOT NULL
          AND p.status IN ('pending', 'running')
        GROUP BY s.id
      `;

      const seenChildren = new Set<string>();
      for (const row of rows) {
        seenChildren.add(row.child_id);

        // Skip children that issued an active expect_quiet_for hint.
        // The child told us it would be silent for a reason (long
        // npm install, build, test suite); honor the hint rather
        // than escalate.
        if (cfg.quietHints?.isQuiet(row.child_id, now)) continue;

        // Check parent's agent kind — watchdog only fires for
        // orchestrator parents. Cache miss is fine; this is a small N.
        const parent = await cfg.sql<{ agent_id: string }[]>`
          SELECT agent_id FROM sessions WHERE id = ${row.parent_session_id}
        `;
        const parentAgentId = parent[0]?.agent_id;
        if (!parentAgentId) continue;
        const parentAgent = await cfg.agents.findById(
          parentAgentId as AgentId,
        );
        if (!parentAgent || !isOrchestratorKind(parentAgent.kind)) continue;

        const lastActivity =
          typeof row.last_activity === "string"
            ? new Date(row.last_activity)
            : row.last_activity;
        const silenceSeconds = Math.floor(
          (now.getTime() - lastActivity.getTime()) / 1000,
        );

        const prev = state.get(row.child_id);
        // Any fresh activity since we last saw this child → reset the
        // backoff counter to attempt 1. The comparison is strict
        // inequality so we don't reset on a tick that saw the same
        // last_activity as before.
        if (prev && lastActivity.getTime() > prev.lastObservedActivity.getTime()) {
          state.set(row.child_id, {
            attempt: 0,
            lastObservedActivity: lastActivity,
          });
        } else if (!prev) {
          state.set(row.child_id, {
            attempt: 0,
            lastObservedActivity: lastActivity,
          });
        }

        const current = state.get(row.child_id)!;
        const nextAttempt = current.attempt + 1;
        const threshold = thresholdSecondsForAttempt(nextAttempt);

        if (silenceSeconds < threshold) continue;

        // Look up child agent for slug. Not fatal if it fails; we
        // pass "<unknown>" as a fallback.
        const childAgent = await cfg.agents.findById(
          row.child_agent_id as AgentId,
        );
        const childSlug = childAgent?.slug ?? "<unknown>";

        try {
          await publishWatchdogWake(
            cfg.nc,
            row.parent_session_id,
            row.child_id,
            String(childSlug),
            silenceSeconds,
            nextAttempt,
          );
          current.attempt = nextAttempt;
          console.log(
            `[watchdog] fired attempt=${nextAttempt} on child ${row.child_id.slice(0, 8)} (${childSlug}): silent ${silenceSeconds}s`,
          );
        } catch (err) {
          console.warn(
            `[watchdog] publish failed for child ${row.child_id}: ${(err as Error).message}`,
          );
        }
      }

      // GC state for children no longer in the candidate set
      // (terminated, parent died, etc.). Prevents unbounded growth.
      for (const sid of state.keys()) {
        if (!seenChildren.has(sid)) state.delete(sid);
      }
    } catch (err) {
      onError(err);
    } finally {
      ticking = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
    (handle as unknown as { unref: () => void }).unref();
  }
  console.log(
    `[watchdog] started (interval=${intervalMs}ms, backoff minutes=${BACKOFF_MINUTES.join("/")})`,
  );

  return {
    async stop() {
      running = false;
      clearInterval(handle);
    },
  };
}

/** Exported for tests. */
export const _testing = { thresholdSecondsForAttempt, BACKOFF_MINUTES };
