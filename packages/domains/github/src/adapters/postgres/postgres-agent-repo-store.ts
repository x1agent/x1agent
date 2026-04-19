import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import type {
  AgentRepoStore,
  AttachRepoOptions,
  LinkedRepo,
} from "../../ports/agent-repo-store.js";
import { InstallationId } from "../../domain/installation.js";

type Sql = postgres.Sql<Record<string, unknown>>;

function defaultMountPath(repoFullName: string): string {
  const slash = repoFullName.indexOf("/");
  return slash < 0 ? repoFullName : repoFullName.slice(slash + 1);
}

/**
 * Thin adapter onto the agents + agent_repos tables. Lives in the github
 * domain package (rather than importing the agents postgres adapter)
 * because the github use cases are the only consumers today; we can
 * move it later if it accumulates non-GitHub callers.
 */
export class PostgresAgentRepoStore implements AgentRepoStore {
  constructor(private readonly sql: Sql) {}

  async getLinkedInstallation(agentId: string) {
    const rows = await this.sql<{ linked_installation_id: string | null }[]>`
      SELECT linked_installation_id FROM agents WHERE id = ${agentId}
    `;
    const v = rows[0]?.linked_installation_id;
    return v === null || v === undefined ? null : InstallationId(Number(v));
  }

  async setLinkedInstallation(agentId: string, id: InstallationId) {
    await this.sql`
      UPDATE agents SET linked_installation_id = ${id}, updated_at = now()
      WHERE id = ${agentId}
    `;
  }

  async attachRepo(
    agentId: string,
    repo: string,
    options: AttachRepoOptions = {},
  ) {
    const branch = options.branch ?? "main";
    const mountPath = options.mountPath ?? defaultMountPath(repo);
    const autoPush = options.autoPush ?? false;
    await this.sql`
      INSERT INTO agent_repos
        (agent_id, repo_full_name, branch, mount_path, auto_push)
      VALUES
        (${agentId}, ${repo}, ${branch}, ${mountPath}, ${autoPush})
      ON CONFLICT (agent_id, repo_full_name) DO NOTHING
    `;
  }

  async updateRepo(
    agentId: string,
    repo: string,
    patch: AttachRepoOptions,
  ) {
    await this.sql`
      UPDATE agent_repos SET
        branch     = COALESCE(${patch.branch ?? null}, branch),
        mount_path = COALESCE(${patch.mountPath ?? null}, mount_path),
        auto_push  = COALESCE(${patch.autoPush ?? null}, auto_push)
      WHERE agent_id = ${agentId} AND repo_full_name = ${repo}
    `;
  }

  async detachRepo(agentId: string, repo: string) {
    await this.sql`
      DELETE FROM agent_repos
      WHERE agent_id = ${agentId} AND repo_full_name = ${repo}
    `;
  }

  async listRepos(agentId: string): Promise<readonly LinkedRepo[]> {
    const rows = await this.sql<
      {
        repo_full_name: string;
        branch: string;
        mount_path: string;
        auto_push: boolean;
      }[]
    >`
      SELECT repo_full_name, branch, mount_path, auto_push
      FROM agent_repos
      WHERE agent_id = ${agentId}
      ORDER BY created_at
    `;
    return rows.map((r) => ({
      repoFullName: r.repo_full_name,
      branch: r.branch,
      mountPath: r.mount_path,
      autoPush: r.auto_push,
    }));
  }

  async getAgentWorkspaceAndOwner(agentId: string) {
    const rows = await this.sql<
      { workspace_id: string; created_by: string | null }[]
    >`
      SELECT workspace_id, created_by FROM agents WHERE id = ${agentId}
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      workspaceId: r.workspace_id,
      createdBy: r.created_by ? UserId(r.created_by) : null,
    };
  }
}
