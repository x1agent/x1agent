import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentRepository } from "../ports/agent-repository.js";
import type { Agent } from "../domain/agent.js";

/**
 * Listing requires any workspace membership (enforced upstream via a
 * standard `assertRoleForSlug` middleware in the HTTP adapter). The
 * application service just runs the query.
 */
export async function listAgents(
  agents: AgentRepository,
  _actor: UserId,
  workspaceId: WorkspaceId,
): Promise<readonly Agent[]> {
  return agents.listByWorkspace(workspaceId);
}
