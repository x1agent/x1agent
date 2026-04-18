import type { UserId } from "@x1agent/kernel";
import type { AgentRepository } from "../ports/agent-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import { AgentNotFoundError, type AgentId } from "../domain/agent.js";

export interface DeleteAgentDeps {
  agents: AgentRepository;
  adminGuard: AdminGuard;
}

export async function deleteAgent(
  deps: DeleteAgentDeps,
  actor: UserId,
  agentId: AgentId,
): Promise<void> {
  const current = await deps.agents.findById(agentId);
  if (!current) throw new AgentNotFoundError(agentId);

  await deps.adminGuard.assertAdmin(actor, current.workspaceId);
  await deps.agents.delete(agentId);
}
