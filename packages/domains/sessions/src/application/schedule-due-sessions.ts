import type { Clock } from "@x1agent/kernel";
import type { Agent, AgentRepository } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import { SessionDuplicateTickError } from "../domain/session.js";
import { nextDueAfter } from "./next-due.js";

export interface ScheduleDueSessionsDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  clock: Clock;
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
    skippedDuplicate: 0,
    errors: 0,
  };

  for (const agent of agents) {
    if (!agent.schedule) continue;
    try {
      const last = await deps.sessions.lastSchedulerRunFor(agent.id);
      const anchor = last?.triggeredAt ?? agent.createdAt;
      const due = nextDueAfter(agent.schedule, anchor);
      if (due.getTime() > now.getTime()) continue;

      try {
        await deps.sessions.create({
          agentId: agent.id,
          triggeredBy: "scheduler",
          triggeredByUserId: null,
          parentSessionId: null,
          parentAgentId: null,
          triggeredAt: due,
        });
        result.created += 1;
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
