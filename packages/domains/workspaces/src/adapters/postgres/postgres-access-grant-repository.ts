import type postgres from "postgres";
import {
  emailDomain,
  type AccessGrantKind,
  type AccessGrantRole,
  type WorkspaceAccessGrant,
} from "../../domain/access-grant.js";
import type {
  AccessGrantRepository,
  CreateAccessGrantInput,
} from "../../ports/access-grant-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  kind: string;
  value: string;
  default_role: string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  created_by: string | null;
}

function toGrant(r: Row): WorkspaceAccessGrant {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as AccessGrantKind,
    value: r.value,
    defaultRole: (r.default_role as AccessGrantRole | null) ?? null,
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    createdAt: new Date(r.created_at),
    createdBy: r.created_by,
  };
}

const SELECT = `
  id, workspace_id, kind, value, default_role, expires_at, created_at, created_by
`;

export class PostgresAccessGrantRepository implements AccessGrantRepository {
  constructor(private readonly sql: Sql) {}

  async listForWorkspace(workspaceId: string): Promise<WorkspaceAccessGrant[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)}
      FROM workspace_access_grants
      WHERE workspace_id = ${workspaceId}
      ORDER BY kind ASC, value ASC
    `;
    return rows.map(toGrant);
  }

  async upsert(
    input: CreateAccessGrantInput,
  ): Promise<WorkspaceAccessGrant> {
    const rows = await this.sql<Row[]>`
      INSERT INTO workspace_access_grants
        (workspace_id, kind, value, default_role, expires_at, created_by)
      VALUES (
        ${input.workspaceId}, ${input.kind}, ${input.value},
        ${input.defaultRole}, ${input.expiresAt}, ${input.createdBy}
      )
      ON CONFLICT (workspace_id, kind, value) DO UPDATE SET
        default_role = EXCLUDED.default_role,
        expires_at   = EXCLUDED.expires_at,
        created_by   = COALESCE(workspace_access_grants.created_by, EXCLUDED.created_by)
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    if (rows.length === 0) {
      throw new Error("workspace_access_grants upsert returned no row");
    }
    return toGrant(rows[0]!);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM workspace_access_grants
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `;
    return (result.count ?? 0) > 0;
  }

  async findMatchesForEmail(
    email: string,
  ): Promise<WorkspaceAccessGrant[]> {
    const lower = email.trim().toLowerCase();
    const domain = emailDomain(lower);
    if (!domain) return [];
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)}
      FROM workspace_access_grants
      WHERE (expires_at IS NULL OR expires_at > now())
        AND (
          (kind = 'email'  AND value = ${lower})
          OR (kind = 'domain' AND value = ${domain})
        )
    `;
    return rows.map(toGrant);
  }
}
