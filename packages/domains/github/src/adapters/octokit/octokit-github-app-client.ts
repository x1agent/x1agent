import { App } from "@octokit/app";
import type {
  GitHubAppClient,
  GitHubInstallationInfo,
} from "../../ports/github-app-client.js";
import { InstallationId } from "../../domain/installation.js";
import type { InstallationRepo } from "../../domain/repo.js";

export interface OctokitGitHubAppClientConfig {
  appId: number;
  privateKey: string;
  appSlug: string;
}

/**
 * Real GitHubAppClient. All app-level calls go through a single @octokit/app
 * instance; per-installation calls get their own short-lived client with
 * an installation-scoped token.
 */
export class OctokitGitHubAppClient implements GitHubAppClient {
  readonly appSlug: string;
  private readonly app: App;

  constructor(cfg: OctokitGitHubAppClientConfig) {
    this.appSlug = cfg.appSlug;
    this.app = new App({
      appId: cfg.appId,
      privateKey: cfg.privateKey,
    });
  }

  async getInstallation(
    installationId: InstallationId,
  ): Promise<GitHubInstallationInfo> {
    const res = await this.app.octokit.request(
      "GET /app/installations/{installation_id}",
      { installation_id: installationId },
    );
    const acc = res.data.account;
    if (!acc || typeof acc !== "object" || !("login" in acc)) {
      throw new Error("installation.account is missing login");
    }
    return {
      installationId: InstallationId(res.data.id),
      accountLogin: (acc as { login: string }).login,
      accountType:
        (acc as { type?: string }).type === "Organization"
          ? "Organization"
          : "User",
      repositorySelection:
        res.data.repository_selection === "all" ? "all" : "selected",
    };
  }

  async listInstallationRepos(
    installationId: InstallationId,
  ): Promise<readonly InstallationRepo[]> {
    const kit = await this.app.getInstallationOctokit(installationId);
    const repos: InstallationRepo[] = [];
    let page = 1;
    while (true) {
      const res = await kit.request("GET /installation/repositories", {
        per_page: 100,
        page,
      });
      for (const r of res.data.repositories) {
        repos.push({
          fullName: r.full_name,
          id: r.id,
          defaultBranch: r.default_branch ?? "main",
          private: !!r.private,
        });
      }
      if (res.data.repositories.length < 100) break;
      page++;
    }
    return repos;
  }

  async mintInstallationToken(installationId: InstallationId) {
    const auth = await this.app.octokit.auth({
      type: "installation",
      installationId,
    });
    const a = auth as { token: string; expiresAt?: string };
    return {
      token: a.token,
      expiresAt: a.expiresAt
        ? new Date(a.expiresAt)
        : new Date(Date.now() + 55 * 60 * 1000),
    };
  }
}
