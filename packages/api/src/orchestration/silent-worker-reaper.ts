import type postgres from "postgres";
import type { AgentRepository, AgentId } from "@x1agent/domain-agents";
import { isOrchestratorKind } from "@x1agent/domain-agents";
import {
  appendSessionEvent,
  type JobTerminator,
  type SessionEventRepository,
  type SessionId,
  type SessionRepository,
} from "@x1agent/domain-sessions";
import { systemClock } from "@x1agent/kernel";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Silent-worker reaper (X1A-28b).
 *
 * Periodically sweeps for WORKER sessions whose session_events stream
 * has been silent past a configurable threshold and cancels them
 * outright. Distinct from the activity watchdog (which publishes a
 * wake to the parent at 5 minutes) — the reaper is the hard
 * termination after the parent has had a chance to react. Without
 * this a deadlocked `bun install` keeps burning the worker pod's
 * entire activeDeadlineSeconds budget (default 1h) while the
 * orchestrator has long given up on it.
 *
 * Scope rules:
 *   • Only workers (non-orchestrator agent kind) are eligible. Nested
 *     orchestrators are deliberately exempt — they intentionally sit
 *     idle waiting on children + NATS, which would look identical to
 *     a stuck worker from event-silence alone.
 *   • Only sessions in `pending` or `running` are eligible. A worker
 *     already in a terminal state needs no action.
 *   • Default threshold 30 minutes — well above the watchdog's 5-min
 *     first wake so the orchestrator has time to investigate, decide
 *     to wait longer (`expect_quiet_for`), or cancel itself.
 *   • Respects `expect_quiet_for` hints the same way the watchdog
 *     does. A worker that legitimately needs a 45-minute test suite
 *     posts a hint and the reaper skips it.
 *
 * The cancel path: DB flip → audit event → K8s Job delete. Same shape
 * as `cancelChildSession` minus the parent-relationship check (the
 * caller is the platform, not a parent session).
 */
export interface SilentWorkerReaperConfig {
  sql: Sql;
  agents: AgentRepository;
  sessions: SessionRepository;
  events: SessionEventRepository;
  jobs?: JobTerminator;
  /**
   * Optional store of "expect quiet for N seconds" hints (shared with
   * the activity watchdog). When a hint is active, we skip the
   * child — the worker told us it would be silent on purpose.
   */
  quietHints?: import("./quiet-hints.js").QuietHintStore;
  /** Poll interval in ms. Defaults to 120s. */
  intervalMs?: number;
  /** Silence threshold in ms before a worker is reaped. Defaults to 30 min. */
  silenceThresholdMs?: number;
  /** Called on fatal per-tick errors. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

export interface SilentWorkerReaperHandle {
  stop: () => Promise<void>;
}

interface SilentWorkerRow {
  child_id: string;
  child_agent_id: string;
  parent_session_id: string | null;
  last_activity: Date | string;
}

const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_SILENCE_THRESHOLD_MS = 30 * 60_000;

export function startSilentWorkerReaper(
  cfg: SilentWorkerReaperConfig,
): SilentWorkerReaperHandle {
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdMs = cfg.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;
  const onError =
    cfg.onError ??
    ((err) =>
      console.warn(
        "[silent-worker-reaper] tick failed:",
        (err as Error).message,
      ));

  let running = true;
  let ticking = false;

  const tick = async () => {
    if (!running || ticking) return;
    ticking = true;
    try {
      const now = new Date();
      // Mirrors the watchdog candidate query but doesn't require an
      // orchestrator parent — a worker spawned by a workspace user is
      // also eligible. COALESCE the last-event timestamp with the
      // session's triggered_at so a worker that emitted zero events
      // still has a silence baseline (silence = time since spawn).
      const rows = await cfg.sql<SilentWorkerRow[]>`
        SELECT
          s.id AS child_id,
          s.agent_id AS child_agent_id,
          s.parent_session_id,
          COALESCE(MAX(e.timestamp), s.triggered_at) AS last_activity
        FROM sessions s
        LEFT JOIN session_events e ON e.session_id = s.id
        WHERE s.status IN ('pending', 'running')
        GROUP BY s.id
      `;

      for (const row of rows) {
        if (cfg.quietHints?.isQuiet(row.child_id, now)) continue;

        // Only reap workers. Orchestrators can idle for hours waiting
        // on a child callback or scheduler tick — silence is not a
        // signal of stuck for them.
        const agent = await cfg.agents.findById(
          row.child_agent_id as AgentId,
        );
        if (!agent) continue;
        if (isOrchestratorKind(agent.kind)) continue;

        const lastActivity =
          typeof row.last_activity === "string"
            ? new Date(row.last_activity)
            : row.last_activity;
        const silenceMs = now.getTime() - lastActivity.getTime();
        if (silenceMs < thresholdMs) continue;

        try {
          await reapWorker(cfg, row.child_id as SessionId, silenceMs);
          console.log(
            `[silent-worker-reaper] reaped ${row.child_id.slice(0, 8)} (${agent.slug}): silent ${Math.floor(silenceMs / 1000)}s`,
          );
        } catch (err) {
          console.warn(
            `[silent-worker-reaper] reap failed for ${row.child_id}: ${(err as Error).message}`,
          );
        }
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
    `[silent-worker-reaper] started (interval=${intervalMs}ms, threshold=${thresholdMs}ms)`,
  );

  return {
    async stop() {
      running = false;
      clearInterval(handle);
    },
  };
}

async function reapWorker(
  cfg: SilentWorkerReaperConfig,
  sessionId: SessionId,
  silenceMs: number,
): Promise<void> {
  const session = await cfg.sessions.findById(sessionId);
  if (!session) return;
  // Re-check terminal state under the same lock-step the watchdog
  // already uses — between candidate query and update the session
  // may have completed on its own.
  if (session.status === "complete" || session.status === "failed") return;

  const wasRunning = session.status === "running";
  await cfg.sessions.updateStatus(sessionId, {
    status: "complete",
    completedAt: systemClock.now(),
    errorMessage: "reaped_for_silence",
  });

  try {
    await appendSessionEvent(
      { events: cfg.events },
      {
        sessionId,
        seq: Date.now(),
        type: "session.cancelled_by_parent",
        payload: {
          parent_session_id: session.parentSessionId ?? null,
          reason: "silent_worker_reaper",
          silence_ms: silenceMs,
        },
        timestamp: systemClock.now(),
      },
    );
  } catch (err) {
    console.warn(
      `[silent-worker-reaper] event emit failed for ${sessionId}: ${(err as Error).message}`,
    );
  }

  if (wasRunning && cfg.jobs) {
    try {
      await cfg.jobs.terminateForSession(sessionId);
    } catch (err) {
      console.warn(
        `[silent-worker-reaper] Job terminate failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
  }
}
