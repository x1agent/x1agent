import type postgres from "postgres";

type Sql = postgres.Sql<Record<string, unknown>>;

export interface AdminMcpWorkspace {
  id: string;
  slug: string;
  name: string;
  role: string;
  oauthMcpsOnOrchestrators: "off" | "on_attended" | "on";
  createdAt: string;
}

export interface AdminMcpWorkspaceReader {
  listForUser(userId: string): Promise<AdminMcpWorkspace[]>;
  getForUser(userId: string, slug: string): Promise<AdminMcpWorkspace | null>;
}

interface Row {
  id: string;
  slug: string;
  name: string;
  role: string;
  settings: Record<string, unknown> | null;
  created_at: Date | string;
}

function toWorkspace(row: Row): AdminMcpWorkspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    oauthMcpsOnOrchestrators:
      row.settings?.oauthMcpsOnOrchestrators === "on" ||
      row.settings?.oauthMcpsOnOrchestrators === "on_attended"
        ? row.settings.oauthMcpsOnOrchestrators
        : "off",
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Set-based, current-membership reader used by every MCP workspace call. */
export class PostgresAdminMcpWorkspaceReader implements AdminMcpWorkspaceReader {
  constructor(private readonly sql: Sql) {}

  async listForUser(userId: string): Promise<AdminMcpWorkspace[]> {
    const rows = await this.sql<Row[]>`
      SELECT w.id, w.slug, w.name, w.settings, w.created_at, wm.role
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${userId}
        AND w.settings @> '{"adminMcpEnabled": true}'::jsonb
      ORDER BY w.name ASC, w.slug ASC
    `;
    return rows.map(toWorkspace);
  }

  async getForUser(
    userId: string,
    slug: string,
  ): Promise<AdminMcpWorkspace | null> {
    const rows = await this.sql<Row[]>`
      SELECT w.id, w.slug, w.name, w.settings, w.created_at, wm.role
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${userId}
        AND w.slug = ${slug}
        AND w.settings @> '{"adminMcpEnabled": true}'::jsonb
      LIMIT 1
    `;
    return rows[0] ? toWorkspace(rows[0]) : null;
  }
}
