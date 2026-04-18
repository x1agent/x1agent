import type { UserId } from "@x1agent/kernel";
import type { InstallationId } from "../domain/installation.js";

/**
 * Narrow port onto the agents domain for repo linking. The composition
 * root implements this by delegating to agents' PostgresAgentRepository
 * + a small raw-SQL insert/delete on agent_repos. Keeps the github
 * domain from importing agents directly.
 */
export interface AgentRepoStore {
  /**
   * Return the installation currently linked to an agent, or null if
   * the agent has no repos yet. Used to enforce the
   * same-install invariant when the second+ repo is attached.
   */
  getLinkedInstallation(agentId: string): Promise<InstallationId | null>;

  /** Set the agent's linked installation. Idempotent. */
  setLinkedInstallation(
    agentId: string,
    installationId: InstallationId,
  ): Promise<void>;

  /** Add (or no-op) a repo attachment for the agent. */
  attachRepo(agentId: string, repoFullName: string): Promise<void>;

  detachRepo(agentId: string, repoFullName: string): Promise<void>;

  listRepos(agentId: string): Promise<readonly string[]>;

  /** Used by the admin guard check — returns the workspace an agent belongs to. */
  getAgentWorkspaceAndOwner(agentId: string): Promise<{
    workspaceId: string;
    createdBy: UserId | null;
  } | null>;
}
