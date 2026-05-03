import type postgres from "postgres";
import type {
  Attachment,
  AttachmentEnvValue,
} from "../../domain/attachment.js";
import type {
  AttachmentRepository,
  AttachmentUpsertInput,
} from "../../ports/attachment-repository.js";

interface AttachmentRow {
  id: string;
  agent_id: string;
  catalog_entry_id: string;
  env_json: Record<string, AttachmentEnvValue>;
  tool_scopes_granted: string[];
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    agentId: row.agent_id,
    catalogEntryId: row.catalog_entry_id,
    envJson: row.env_json,
    toolScopesGranted: row.tool_scopes_granted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

export class PostgresAttachmentRepository implements AttachmentRepository {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async listByAgent(agentId: string): Promise<Attachment[]> {
    const rows = await this.sql<AttachmentRow[]>`
      SELECT id, agent_id, catalog_entry_id, env_json, tool_scopes_granted,
             created_at, updated_at, created_by
      FROM agent_mcp_attachments
      WHERE agent_id = ${agentId}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToAttachment);
  }

  async getById(agentId: string, id: string): Promise<Attachment | null> {
    const [row] = await this.sql<AttachmentRow[]>`
      SELECT id, agent_id, catalog_entry_id, env_json, tool_scopes_granted,
             created_at, updated_at, created_by
      FROM agent_mcp_attachments
      WHERE agent_id = ${agentId} AND id = ${id}
    `;
    return row ? rowToAttachment(row) : null;
  }

  async upsert(input: AttachmentUpsertInput): Promise<Attachment> {
    const [row] = await this.sql<AttachmentRow[]>`
      INSERT INTO agent_mcp_attachments
        (agent_id, catalog_entry_id, env_json, tool_scopes_granted, created_by)
      VALUES (
        ${input.agentId},
        ${input.catalogEntryId},
        ${this.sql.json(input.envJson as never)},
        ${this.sql.json(input.toolScopesGranted as never)},
        ${input.createdBy}
      )
      ON CONFLICT (agent_id, catalog_entry_id) DO UPDATE SET
        env_json = EXCLUDED.env_json,
        tool_scopes_granted = EXCLUDED.tool_scopes_granted,
        updated_at = now()
      RETURNING id, agent_id, catalog_entry_id, env_json, tool_scopes_granted,
                created_at, updated_at, created_by
    `;
    if (!row) throw new Error("agent_mcp_attachments upsert returned no row");
    return rowToAttachment(row);
  }

  async delete(agentId: string, id: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM agent_mcp_attachments
      WHERE agent_id = ${agentId} AND id = ${id}
    `;
    return (result.count ?? 0) > 0;
  }

  async countByCatalogEntry(catalogEntryId: string): Promise<number> {
    const [row] = await this.sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c
      FROM agent_mcp_attachments
      WHERE catalog_entry_id = ${catalogEntryId}
    `;
    return Number(row?.c ?? "0");
  }
}
