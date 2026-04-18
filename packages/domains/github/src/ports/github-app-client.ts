import type { InstallationId } from "../domain/installation.js";
import type { InstallationRepo } from "../domain/repo.js";

export interface GitHubInstallationInfo {
  installationId: InstallationId;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
}

/**
 * Adapter-facing port for the GitHub App API. Real implementation wraps
 * Octokit with app JWT auth; tests inject an in-memory fake.
 *
 * No token the client returns ever leaves the sidecar at runtime — the
 * credential proxy fetches a fresh installation token on every operation
 * and drops it after use. See docs/security/credential-proxy.
 */
export interface GitHubAppClient {
  /** The App slug, used to build the installation URL in the UI. */
  readonly appSlug: string;

  /** Fetch installation metadata (used on callback after install). */
  getInstallation(
    installationId: InstallationId,
  ): Promise<GitHubInstallationInfo>;

  /**
   * List the repositories the installation has access to. Paginated
   * server-side; implementations fetch all pages.
   */
  listInstallationRepos(
    installationId: InstallationId,
  ): Promise<readonly InstallationRepo[]>;

  /**
   * Mint a short-lived installation access token. Used by the sidecar's
   * git-credential-helper proxy at session time.
   */
  mintInstallationToken(
    installationId: InstallationId,
  ): Promise<{ token: string; expiresAt: Date }>;
}
