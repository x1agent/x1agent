import type { UserId } from "@x1agent/kernel";
import type { GitHubAppClient } from "../ports/github-app-client.js";
import type { InstallationRepository } from "../ports/installation-repository.js";
import type { Installation, InstallationId } from "../domain/installation.js";

export interface RecordInstallationDeps {
  client: GitHubAppClient;
  installations: InstallationRepository;
}

/**
 * Called from the GitHub App callback. GitHub redirects the user back
 * with ?installation_id=... after install; we hydrate the details via
 * the App API and persist them.
 */
export async function recordInstallation(
  deps: RecordInstallationDeps,
  input: { installationId: InstallationId; actor: UserId },
): Promise<Installation> {
  const info = await deps.client.getInstallation(input.installationId);
  return deps.installations.upsert({
    installationId: info.installationId,
    accountLogin: info.accountLogin,
    accountType: info.accountType,
    installedByUserId: input.actor,
    repositorySelection: info.repositorySelection,
  });
}
