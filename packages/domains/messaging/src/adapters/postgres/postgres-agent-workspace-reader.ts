import type postgres from "postgres";
import { WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "../../domain/slack-bot-config.js";
import type { AgentWorkspaceReader } from "../../ports/agent-workspace-reader.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  workspace_id: string;
}

/**
 * Reads the `agents` table for the workspace owning a given agent id.
 * Used by the messaging domain to enforce tenant isolation on pair
 * requests (see CLAUDE.md principle 7).
 *
 * Implemented as a raw SQL read rather than depending on the agents
 * domain's repository — the read is a single column lookup and the
 * messaging package has no other reason to pull in `@x1agent/domain-agents`.
 */
export class PostgresAgentWorkspaceReader implements AgentWorkspaceReader {
  constructor(private readonly sql: Sql) {}

  async findWorkspaceId(agentId: AgentId) {
    const rows = await this.sql<Row[]>`
      SELECT workspace_id FROM agents WHERE id = ${agentId} LIMIT 1
    `;
    if (!rows[0]) return null;
    return WorkspaceId(rows[0].workspace_id);
  }
}
