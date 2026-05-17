import type { Clock } from "@x1agent/kernel";
import {
  isOrchestratorKind,
  type Agent,
  type AgentRepository,
} from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { MessageInjector } from "../ports/message-injector.js";
import { SessionDuplicateTickError } from "../domain/session.js";
import { nextDueAfter } from "./next-due.js";

export interface ScheduleDueSessionsDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  clock: Clock;
  /**
   * Optional: message injector used when the agent is an orchestrator
   * with a live session. When unset, orchestrator ticks fall back to
   * the create-new-session path (which will fail the DB singleton
   * trigger if a live session exists — so this should always be wired
   * in prod composition).
   */
  injector?: MessageInjector;
  /**
   * Optional: surface per-agent failures without aborting the whole tick.
   * Defaults to console.warn. Returning normally is enough — the tick
   * keeps going regardless of what this function does.
   */
  onError?: (agent: Agent, err: unknown) => void;
}

export interface ScheduleDueSessionsResult {
  considered: number;
  created: number;
  /** Orchestrator ticks that injected into an existing live session. */
  injected: number;
  skippedDuplicate: number;
  errors: number;
}

/**
 * One scheduler tick. Walk every active+scheduled agent; for each, compute
 * the next due time from the agent's last scheduler-triggered session (or
 * its createdAt, for agents that have never run) and insert a pending
 * session if that time is now in the past. Duplicate-tick races are
 * caught and counted, not propagated.
 */
export async function scheduleDueSessions(
  deps: ScheduleDueSessionsDeps,
): Promise<ScheduleDueSessionsResult> {
  const now = deps.clock.now();
  const agents = await deps.agents.listScheduled();

  const result: ScheduleDueSessionsResult = {
    considered: agents.length,
    created: 0,
    injected: 0,
    skippedDuplicate: 0,
    errors: 0,
  };

  for (const agent of agents) {
    if (!agent.schedule) continue;
    try {
      // Orchestrators use `last_scheduler_tick_at` as the anchor because
      // a tick that injects (doesn't create a new sessions row) wouldn't
      // advance lastSchedulerRunFor. Workers + scheduled keep using the
      // session-row anchor for backward compat and to preserve the
      // duplicate-tick-caught-at-insert semantics.
      const anchor = isOrchestratorKind(agent.kind)
        ? (agent.lastSchedulerTickAt ?? agent.createdAt)
        : ((await deps.sessions.lastSchedulerRunFor(agent.id))?.triggeredAt
            ?? agent.createdAt);
      const due = nextDueAfter(agent.schedule, anchor);
      if (due.getTime() > now.getTime()) continue;

      // No-backfill policy applies ONLY to worker/scheduled kinds.
      //
      // For workers, a tick = sessions.create() = a new pod. Missing
      // N slots and catching up would spawn N pods — the phantom-
      // session backlog this rule exists to prevent. Skip those slots
      // and advance the anchor to `now`.
      //
      // For orchestrators, a tick = injectHeartbeatWake() into the
      // live session (or sessions.create() if there isn't one).
      // There is NO backlog to create — one wake catches the agent
      // up regardless of how many slots passed. The old behavior
      // silently no-op'd the orchestrator schedule whenever
      // `last_scheduler_tick_at` was NULL and `created_at` was more
      // than one interval before the first cron-match (common: any
      // operator who sets a daily schedule on an agent that's been
      // alive more than a day). Fire one heartbeat instead of eating
      // it.
      if (!isOrchestratorKind(agent.kind)) {
        const slotAfterDue = nextDueAfter(agent.schedule, due);
        const intervalMs = slotAfterDue.getTime() - due.getTime();
        if (now.getTime() - due.getTime() > intervalMs) {
          await deps.agents.recordSchedulerTick(agent.id, now);
          continue;
        }
      }

      if (isOrchestratorKind(agent.kind)) {
        // Branch: find-or-create. Live session → inject heartbeat;
        // no live session → create a new session with heartbeat as
        // initial prompt (existing create path, same as workers).
        const live = await deps.sessions.findLiveSessionForAgent(agent.id);
        if (live) {
          if (!deps.injector) {
            throw new Error(
              "orchestrator tick requires a MessageInjector but none was configured",
            );
          }
          await deps.injector.injectHeartbeatWake(live.id, agent.heartbeatMd);
          result.injected += 1;
        } else {
          await deps.sessions.create({
            agentId: agent.id,
            triggeredBy: "scheduler",
            // Impersonate the admin-configured run-as user so any
            // remote_oauth MCPs the agent has attached can mint tokens
            // at session-spawn time. Defaults to agent.createdBy via
            // migration 044's backfill; null only when the creator left
            // and the field hasn't been re-picked. See
            // docs/architecture/orchestration.md § Scheduler attribution.
            triggeredByUserId: agent.scheduledRunAsUserId,
            parentSessionId: null,
            parentAgentId: null,
            resumedFromSessionId: null,
            triggeredAt: due,
          });
          result.created += 1;
        }
        await deps.agents.recordSchedulerTick(agent.id, due);
        continue;
      }

      // worker / scheduled kinds — unchanged behavior, create a new
      // session per tick.
      try {
        await deps.sessions.create({
          agentId: agent.id,
          triggeredBy: "scheduler",
          triggeredByUserId: null,
          parentSessionId: null,
          parentAgentId: null,
          resumedFromSessionId: null,
          triggeredAt: due,
        });
        result.created += 1;
        await deps.agents.recordSchedulerTick(agent.id, due);
      } catch (err) {
        if (err instanceof SessionDuplicateTickError) {
          result.skippedDuplicate += 1;
        } else {
          throw err;
        }
      }
    } catch (err) {
      result.errors += 1;
      (deps.onError ?? defaultOnError)(agent, err);
    }
  }

  return result;
}

function defaultOnError(agent: Agent, err: unknown) {
  console.warn(
    `[scheduler] agent ${agent.id} (${agent.slug}) tick failed:`,
    err,
  );
}
