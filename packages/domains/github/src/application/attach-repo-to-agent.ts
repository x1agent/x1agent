import type { UserId } from "@x1agent/kernel";
import type { GitHubAppClient } from "../ports/github-app-client.js";
import type { InstallationRepository } from "../ports/installation-repository.js";
import type { AgentRepoStore } from "../ports/agent-repo-store.js";
import type { InstallationId } from "../domain/installation.js";
import {
  InstallationNotFoundError,
  InstallationNotOwnedError,
} from "../domain/installation.js";
import {
  RepoInstallationMismatchError,
  RepoNotInInstallationError,
} from "../domain/repo.js";

export interface AttachRepoDeps {
  client: GitHubAppClient;
  installations: InstallationRepository;
  agentRepos: AgentRepoStore;
}

/**
 * Attach a repo to an agent, enforcing every layer of the invariant
 * "all repos on an agent share one installation, and that installation
 * was granted by the requesting user."
 *
 *   1. The installation exists in our DB and is not revoked.
 *   2. The installation was granted by the acting user.
 *   3. The repo is visible to that installation (verified against GitHub
 *      live, not trusted from client input).
 *   4. If the agent already has repos, the new repo's installation
 *      matches the agent's linked installation.
 */
export async function attachRepoToAgent(
  deps: AttachRepoDeps,
  input: {
    actor: UserId;
    agentId: string;
    installationId: InstallationId;
    repoFullName: string;
    branch?: string;
    mountPath?: string;
    autoPush?: boolean;
    allowPush?: boolean;
  },
): Promise<void> {
  const install = await deps.installations.findByInstallationId(
    input.installationId,
  );
  if (!install || install.revokedAt)
    throw new InstallationNotFoundError(input.installationId);
  if (install.installedByUserId !== input.actor)
    throw new InstallationNotOwnedError(input.installationId, input.actor);

  // The only list we trust for "is this repo attached to this install"
  // is the one GitHub gives us via the app JWT — never the client.
  const accessible = await deps.client.listInstallationRepos(
    input.installationId,
  );
  const match = accessible.find((r) => r.fullName === input.repoFullName);
  if (!match) {
    throw new RepoNotInInstallationError(
      input.repoFullName,
      input.installationId,
    );
  }

  const existingInstall = await deps.agentRepos.getLinkedInstallation(
    input.agentId,
  );
  if (existingInstall !== null && existingInstall !== input.installationId) {
    throw new RepoInstallationMismatchError(
      existingInstall,
      input.installationId,
    );
  }

  if (existingInstall === null) {
    await deps.agentRepos.setLinkedInstallation(
      input.agentId,
      input.installationId,
    );
  }
  // If the caller didn't specify a branch, default to the repo's own
  // default branch rather than a hardcoded "main" — private repos often
  // use "master" or a custom default.
  await deps.agentRepos.attachRepo(input.agentId, input.repoFullName, {
    branch: input.branch ?? match.defaultBranch,
    mountPath: input.mountPath,
    autoPush: input.autoPush,
    allowPush: input.allowPush,
  });
}
