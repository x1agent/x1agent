import type { Clock, UserId } from "@x1agent/kernel";
import type { Agent, AgentId, AgentRepository } from "@x1agent/domain-agents";
import { AgentNotFoundError } from "@x1agent/domain-agents";
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
 * A user asks to run an agent now. We check the caller is a workspace
 * admin, then record a pending session. Execution is a separate concern.
 */
export async function triggerSession(
  deps: TriggerSessionDeps,
  input: TriggerSessionInput,
): Promise<Session> {
  const agent = await loadAgent(deps.agents, input.agentId);
  await deps.adminGuard.assertAdmin(input.actor, agent.workspaceId);
  return deps.sessions.create({
    agentId: agent.id,
    triggeredBy: "user",
    triggeredByUserId: input.actor,
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
