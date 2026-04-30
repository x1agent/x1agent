import type { UserId } from "@x1agent/kernel";
import type { InstallationId } from "../domain/installation.js";

/**
 * A linked repo with the on-disk placement and git branching configuration
 * the sidecar needs to clone and check out at session start.
 *
 * Push gating — see docs/security/repo-access.md.
 *
 *   autoPush  — orchestration hint: whether the agent is expected to
 *               push on its own cadence (vs. a human merging the
 *               branch). Advisory.
 *   allowPush — enforcement: when false, the sidecar's credential
 *               helper refuses to hand out credentials. `git push`
 *               and network-dependent `git fetch` fail; the agent
 *               can still read, edit, and commit locally. Defaults
 *               to false on new attachments (safe-by-default).
 */
export interface LinkedRepo {
  repoFullName: string;
  branch: string;
  mountPath: string;
  autoPush: boolean;
  allowPush: boolean;
}

export interface AttachRepoOptions {
  branch?: string;
  mountPath?: string;
  autoPush?: boolean;
  allowPush?: boolean;
}

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

  /**
   * Add (or no-op) a repo attachment for the agent. `branch` defaults to
   * 'main' when not provided; `mountPath` defaults to the repo name
   * (everything after the slash in `owner/repo`); `autoPush` defaults to
   * false.
   */
  attachRepo(
    agentId: string,
    repoFullName: string,
    options?: AttachRepoOptions,
  ): Promise<void>;

  /** Patch branch / mount_path / auto_push on an existing attachment. */
  updateRepo(
    agentId: string,
    repoFullName: string,
    patch: AttachRepoOptions,
  ): Promise<void>;

  detachRepo(agentId: string, repoFullName: string): Promise<void>;

  listRepos(agentId: string): Promise<readonly LinkedRepo[]>;

  /** Used by the admin guard check — returns the workspace an agent belongs to. */
  getAgentWorkspaceAndOwner(agentId: string): Promise<{
    workspaceId: string;
    createdBy: UserId | null;
  } | null>;
}
