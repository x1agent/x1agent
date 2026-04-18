import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import type { AgentRepoStore } from "../../ports/agent-repo-store.js";
import { InstallationId } from "../../domain/installation.js";

type Sql = postgres.Sql<Record<string, unknown>>;

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

  async attachRepo(agentId: string, repo: string) {
    await this.sql`
      INSERT INTO agent_repos (agent_id, repo_full_name)
      VALUES (${agentId}, ${repo})
      ON CONFLICT (agent_id, repo_full_name) DO NOTHING
    `;
  }

  async detachRepo(agentId: string, repo: string) {
    await this.sql`
      DELETE FROM agent_repos
      WHERE agent_id = ${agentId} AND repo_full_name = ${repo}
    `;
  }

  async listRepos(agentId: string) {
    const rows = await this.sql<{ repo_full_name: string }[]>`
      SELECT repo_full_name FROM agent_repos
      WHERE agent_id = ${agentId}
      ORDER BY created_at
    `;
    return rows.map((r) => r.repo_full_name);
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
