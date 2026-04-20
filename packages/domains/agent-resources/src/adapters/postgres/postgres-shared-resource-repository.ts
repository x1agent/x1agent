import type postgres from "postgres";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import {
  SharedResourceId,
  SharedResourceKind,
  type SharedResource,
  type SharedResourceStatus,
} from "../../domain/shared-resource.js";
import type {
  CreateSharedResourceInput,
  SharedResourceRepository,
} from "../../ports/shared-resource-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  kind: string;
  version: string;
  provider: string;
  config: Record<string, unknown>;
  admin_secret_ref: string;
  status: string;
  status_reason: string | null;
  installed_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toResource(r: Row): SharedResource {
  return {
    id: SharedResourceId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    kind: SharedResourceKind(r.kind),
    version: r.version,
    provider: r.provider,
    config: r.config,
    adminSecretRef: r.admin_secret_ref,
    status: r.status as SharedResourceStatus,
    statusReason: r.status_reason,
    installedBy: r.installed_by ? UserId(r.installed_by) : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

const SELECT = `
  id, workspace_id, kind, version, provider, config, admin_secret_ref,
  status, status_reason, installed_by, created_at, updated_at
`;

export class PostgresSharedResourceRepository
  implements SharedResourceRepository
{
  constructor(private readonly sql: Sql) {}

  async create(input: CreateSharedResourceInput): Promise<SharedResource> {
    const rows = await this.sql<Row[]>`
      INSERT INTO workspace_shared_resources
        (workspace_id, kind, version, provider, config, admin_secret_ref,
         installed_by)
      VALUES
        (${input.workspaceId}, ${input.kind}, ${input.version},
         ${input.provider}, ${this.sql.json(input.config as postgres.JSONValue)},
         ${input.adminSecretRef}, ${input.installedBy})
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toResource(rows[0]!);
  }

  async findById(id: SharedResourceId): Promise<SharedResource | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM workspace_shared_resources
      WHERE id = ${id}
    `;
    return rows[0] ? toResource(rows[0]) : null;
  }

  async findByWorkspaceAndKind(
    workspaceId: WorkspaceId,
    kind: SharedResourceKind,
  ): Promise<SharedResource | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM workspace_shared_resources
      WHERE workspace_id = ${workspaceId} AND kind = ${kind}
    `;
    return rows[0] ? toResource(rows[0]) : null;
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly SharedResource[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM workspace_shared_resources
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at ASC
    `;
    return rows.map(toResource);
  }

  async updateStatus(
    id: SharedResourceId,
    status: SharedResourceStatus,
    reason: string | null,
  ): Promise<void> {
    await this.sql`
      UPDATE workspace_shared_resources
      SET status = ${status},
          status_reason = ${reason},
          updated_at = now()
      WHERE id = ${id}
    `;
  }

  async delete(id: SharedResourceId): Promise<void> {
    await this.sql`DELETE FROM workspace_shared_resources WHERE id = ${id}`;
  }
}
