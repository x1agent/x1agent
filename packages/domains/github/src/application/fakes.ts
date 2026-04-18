import type { UserId } from "@x1agent/kernel";
import type {
  GitHubAppClient,
  GitHubInstallationInfo,
} from "../ports/github-app-client.js";
import type { InstallationRepository } from "../ports/installation-repository.js";
import type { AgentRepoStore } from "../ports/agent-repo-store.js";
import type { InstallationRepo } from "../domain/repo.js";
import {
  InstallationId,
  type Installation,
} from "../domain/installation.js";

let counter = 0x60;
function nextUuid(): string {
  const n = (++counter).toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${n}`;
}

export interface FakeClientConfig {
  installs: Array<{
    id: number;
    accountLogin: string;
    accountType: "User" | "Organization";
    repos: string[];
    repositorySelection?: "all" | "selected";
  }>;
}

export class FakeGitHubAppClient implements GitHubAppClient {
  readonly appSlug = "x1agent-fake";

  constructor(private readonly cfg: FakeClientConfig) {}

  async getInstallation(id: InstallationId): Promise<GitHubInstallationInfo> {
    const hit = this.cfg.installs.find((i) => i.id === id);
    if (!hit) throw new Error(`fake: installation ${id} not configured`);
    return {
      installationId: InstallationId(hit.id),
      accountLogin: hit.accountLogin,
      accountType: hit.accountType,
      repositorySelection: hit.repositorySelection ?? "selected",
    };
  }

  async listInstallationRepos(
    id: InstallationId,
  ): Promise<readonly InstallationRepo[]> {
    const hit = this.cfg.installs.find((i) => i.id === id);
    if (!hit) return [];
    return hit.repos.map((fullName, i) => ({
      fullName,
      id: 10_000 + i,
      defaultBranch: "main",
      private: false,
    }));
  }

  async mintInstallationToken(_id: InstallationId) {
    return {
      token: "fake-installation-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }
}

export class InMemoryInstallationRepository implements InstallationRepository {
  readonly rows: Installation[] = [];

  async findByInstallationId(id: InstallationId) {
    return (
      this.rows.find((r) => r.installationId === id && !r.revokedAt) ?? null
    );
  }
  async listByUser(userId: UserId) {
    return this.rows.filter(
      (r) => r.installedByUserId === userId && !r.revokedAt,
    );
  }
  async upsert(input: {
    installationId: InstallationId;
    accountLogin: string;
    accountType: "User" | "Organization";
    installedByUserId: UserId;
    repositorySelection: "all" | "selected";
  }) {
    const existing = this.rows.find(
      (r) => r.installationId === input.installationId,
    );
    if (existing) {
      existing.accountLogin = input.accountLogin;
      existing.accountType = input.accountType;
      existing.installedByUserId = input.installedByUserId;
      existing.repositorySelection = input.repositorySelection;
      existing.revokedAt = null;
      return existing;
    }
    const row: Installation = {
      id: nextUuid(),
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      installedByUserId: input.installedByUserId,
      repositorySelection: input.repositorySelection,
      createdAt: new Date(),
      revokedAt: null,
    };
    this.rows.push(row);
    return row;
  }
  async markRevoked(id: InstallationId, at: Date) {
    const r = this.rows.find((row) => row.installationId === id);
    if (r) r.revokedAt = at;
  }
}

export class InMemoryAgentRepoStore implements AgentRepoStore {
  readonly agentInstalls = new Map<string, InstallationId>();
  readonly agentRepos = new Map<string, Set<string>>();
  readonly agentMeta = new Map<
    string,
    { workspaceId: string; createdBy: UserId | null }
  >();

  async getLinkedInstallation(agentId: string) {
    return this.agentInstalls.get(agentId) ?? null;
  }
  async setLinkedInstallation(agentId: string, id: InstallationId) {
    this.agentInstalls.set(agentId, id);
  }
  async attachRepo(agentId: string, repo: string) {
    const s = this.agentRepos.get(agentId) ?? new Set<string>();
    s.add(repo);
    this.agentRepos.set(agentId, s);
  }
  async detachRepo(agentId: string, repo: string) {
    this.agentRepos.get(agentId)?.delete(repo);
  }
  async listRepos(agentId: string) {
    return [...(this.agentRepos.get(agentId) ?? [])];
  }
  async getAgentWorkspaceAndOwner(agentId: string) {
    return this.agentMeta.get(agentId) ?? null;
  }

  /** Test helper. */
  seedAgent(agentId: string, workspaceId: string, createdBy: UserId | null) {
    this.agentMeta.set(agentId, { workspaceId, createdBy });
  }
}
