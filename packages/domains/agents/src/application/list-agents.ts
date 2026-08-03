import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentRepository } from "../ports/agent-repository.js";
import type { Agent } from "../domain/agent.js";

/**
 * The repository applies the visibility predicate in the query. This avoids
 * exposing inaccessible agents to an adapter before filtering.
 */
export async function listAgents(
  agents: AgentRepository,
  _actor: UserId,
  workspaceId: WorkspaceId,
): Promise<readonly Agent[]> {
  return agents.listAccessibleByWorkspace(workspaceId, _actor);
}
