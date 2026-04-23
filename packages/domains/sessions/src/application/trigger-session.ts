import type { Clock, UserId } from "@x1agent/kernel";
import type { Agent, AgentId, AgentRepository } from "@x1agent/domain-agents";
import { AgentNotFoundError, isOrchestratorKind } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { Session } from "../domain/session.js";

export interface TriggerSessionDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  adminGuard: AdminGuard;
  clock: Clock;
}

export interface TriggerSessionInput {
  actor: UserId;
  agentId: AgentId;
}

/**
 * A user asks to run an agent now.
 *
 * Workers always create a new pending session — one per trigger.
 *
 * Orchestrators are singletons: at most one non-terminal session per
 * agent at any time. If a live session already exists (pending or
 * running), return it instead of creating a second row. This preserves
 * the "one agent, one long-running conversation" semantics described
 * in docs/architecture/orchestration.md § One agent, one session.
 *
 * Execution (pod spawning) is a separate concern; this just records
 * the session-identity decision.
 */
export async function triggerSession(
  deps: TriggerSessionDeps,
  input: TriggerSessionInput,
): Promise<Session> {
  const agent = await loadAgent(deps.agents, input.agentId);
  await deps.adminGuard.assertAdmin(input.actor, agent.workspaceId);

  if (isOrchestratorKind(agent.kind)) {
    const existing = await deps.sessions.findLiveSessionForAgent(agent.id);
    if (existing) return existing;
  }

  return deps.sessions.create({
    agentId: agent.id,
    triggeredBy: "user",
    triggeredByUserId: input.actor,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: null,
    triggeredAt: deps.clock.now(),
  });
}

async function loadAgent(
  agents: AgentRepository,
  id: AgentId,
): Promise<Agent> {
  const a = await agents.findById(id);
  if (!a) throw new AgentNotFoundError(id);
  return a;
}
