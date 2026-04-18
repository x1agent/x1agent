import type { UserId } from "@x1agent/kernel";
import type {
  AgentRepository,
  UpdateAgentInput,
} from "../ports/agent-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import { AgentNotFoundError, type Agent, type AgentId } from "../domain/agent.js";

export interface UpdateAgentDeps {
  agents: AgentRepository;
  adminGuard: AdminGuard;
}

export async function updateAgent(
  deps: UpdateAgentDeps,
  actor: UserId,
  agentId: AgentId,
  patch: UpdateAgentInput,
): Promise<Agent> {
  const current = await deps.agents.findById(agentId);
  if (!current) throw new AgentNotFoundError(agentId);

  await deps.adminGuard.assertAdmin(actor, current.workspaceId);
  return deps.agents.update(agentId, patch);
}
