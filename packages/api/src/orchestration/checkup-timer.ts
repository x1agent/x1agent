import type postgres from "postgres";
import type { NatsConnection } from "nats";
import type { AgentRepository, AgentId } from "@x1agent/domain-agents";
import { isOrchestratorKind } from "@x1agent/domain-agents";
import {
  publishCheckupWake,
  type ChildSnapshot,
} from "./wake-publisher.js";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Checkup timer. Cadence-driven "just checking in" for orchestrator
 * sessions that have at least one active child. Complements the
 * activity-watchdog (which is per-child silent-detection) by giving
 * the orchestrator periodic glance-opportunities even when nothing
 * is going wrong and every child is emitting events normally.
 *
 * Mechanics:
 *
 *   1. Every intervalMs (default 60s) we sweep. For each
 *      orchestrator session with at least one active child:
 *   2. If its last checkup was > checkupCadenceMs ago (default
 *      15min), assemble a snapshot of every active child (slug,
 *      status, seconds-since-last-event, most recent status detail)
 *      and publish a `checkup` wake.
 *   3. Per-orchestrator "last checkup at" lives in memory. Resets
 *      to now on every fire; resets to zero if the orchestrator
 *      session terminates.
 *
 * If an orchestrator has no active children, no checkup fires —
 * quiescent orchestrators rely on scheduler heartbeats or human
 * messages to be reactivated.
 *
 * See docs/architecture/orchestration.md § Server-driven wakes.
 */
export interface CheckupTimerConfig {
  sql: Sql;
  agents: AgentRepository;
  nc: NatsConnection;
  /** Poll interval in ms. Defaults to 60s. */
  intervalMs?: number;
  /** Minimum time between checkups per orchestrator. Defaults to 15min. */
  checkupCadenceMs?: number;
  /** Called on fatal per-tick errors. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

export interface CheckupTimerHandle {
  stop: () => Promise<void>;
}

interface ChildRow {
  parent_id: string;
  child_id: string;
  child_agent_id: string;
  status: "pending" | "running";
  last_activity: Date | string;
  last_status: string | null;
}

export function startCheckupTimer(
  cfg: CheckupTimerConfig,
): CheckupTimerHandle {
  const intervalMs = cfg.intervalMs ?? 60_000;
  const checkupCadenceMs = cfg.checkupCadenceMs ?? 15 * 60_000;
  const onError =
    cfg.onError ??
    ((err) =>
      console.warn(
        "[checkup] tick failed:",
        (err as Error).message,
      ));

  // parent_session_id → last fired at. In-memory; losing this on
  // restart means the next sweep may fire a fresh checkup
  // immediately, which is harmless.
  const lastFiredAt = new Map<string, Date>();

  let running = true;
  let ticking = false;

  const tick = async () => {
    if (!running || ticking) return;
    ticking = true;
    try {
      const now = new Date();
      // Pull every active child of a live parent plus the most
      // recent agent.status detail per child (correlated subquery).
      // The result set is small — most clusters have a handful of
      // orchestrators each supervising a handful of children.
      const rows = await cfg.sql<ChildRow[]>`
        SELECT
          s.parent_session_id AS parent_id,
          s.id AS child_id,
          s.agent_id AS child_agent_id,
          s.status,
          COALESCE(MAX(e.timestamp), s.triggered_at) AS last_activity,
          (
            SELECT payload->>'detail'
            FROM session_events es
            WHERE es.session_id = s.id
              AND es.type = 'agent.status'
            ORDER BY es.seq DESC
            LIMIT 1
          ) AS last_status
        FROM sessions s
        JOIN sessions p ON p.id = s.parent_session_id
        LEFT JOIN session_events e ON e.session_id = s.id
        WHERE s.status IN ('pending', 'running')
          AND p.status IN ('pending', 'running')
          AND s.parent_session_id IS NOT NULL
        GROUP BY s.parent_session_id, s.id
      `;

      // Bucket children by parent.
      const byParent = new Map<string, ChildRow[]>();
      for (const row of rows) {
        const list = byParent.get(row.parent_id) ?? [];
        list.push(row);
        byParent.set(row.parent_id, list);
      }

      for (const [parentId, children] of byParent) {
        // Only fire checkup if due.
        const last = lastFiredAt.get(parentId);
        if (last && now.getTime() - last.getTime() < checkupCadenceMs) {
          continue;
        }

        // Verify the parent is an orchestrator. Workers don't get
        // checkups even if they (somehow) have children.
        const parent = await cfg.sql<{ agent_id: string }[]>`
          SELECT agent_id FROM sessions WHERE id = ${parentId}
        `;
        const parentAgentId = parent[0]?.agent_id;
        if (!parentAgentId) continue;
        const parentAgent = await cfg.agents.findById(
          parentAgentId as AgentId,
        );
        if (!parentAgent || !isOrchestratorKind(parentAgent.kind)) continue;

        // Build snapshot. Look up slugs via findById for each child.
        const snapshot: ChildSnapshot[] = [];
        for (const row of children) {
          const childAgent = await cfg.agents.findById(
            row.child_agent_id as AgentId,
          );
          const lastActivity =
            typeof row.last_activity === "string"
              ? new Date(row.last_activity)
              : row.last_activity;
          snapshot.push({
            sessionId: row.child_id,
            agentSlug: String(childAgent?.slug ?? "<unknown>"),
            status: row.status,
            secondsSinceLastEvent: Math.floor(
              (now.getTime() - lastActivity.getTime()) / 1000,
            ),
            lastStatus: row.last_status,
          });
        }

        try {
          await publishCheckupWake(cfg.nc, parentId, snapshot);
          lastFiredAt.set(parentId, now);
          console.log(
            `[checkup] fired on orchestrator ${parentId.slice(0, 8)} (${parentAgent.slug}): ${snapshot.length} child(ren)`,
          );
        } catch (err) {
          console.warn(
            `[checkup] publish failed for parent ${parentId}: ${(err as Error).message}`,
          );
        }
      }

      // GC lastFiredAt for parents no longer present (session ended).
      for (const pid of lastFiredAt.keys()) {
        if (!byParent.has(pid)) lastFiredAt.delete(pid);
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
    `[checkup] started (sweep=${intervalMs}ms, cadence=${Math.round(checkupCadenceMs / 1000)}s)`,
  );

  return {
    async stop() {
      running = false;
      clearInterval(handle);
    },
  };
}
