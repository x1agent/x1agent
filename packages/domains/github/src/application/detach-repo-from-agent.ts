import type { UserId } from "@x1agent/kernel";
import type { AgentRepoStore } from "../ports/agent-repo-store.js";

export interface DetachRepoDeps {
  agentRepos: AgentRepoStore;
}

/**
 * Detach a repo from an agent. We don't clear the agent's linked
 * installation even when the last repo is detached — keeping the
 * association makes re-attaching another repo from the same install
 * predictable, and the agent domain owns cleanup on agent delete.
 */
export async function detachRepoFromAgent(
  deps: DetachRepoDeps,
  input: {
    actor: UserId;
    agentId: string;
    repoFullName: string;
  },
): Promise<void> {
  await deps.agentRepos.detachRepo(input.agentId, input.repoFullName);
}
