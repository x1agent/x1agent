import type postgres from "postgres";
import type { WorkspaceEnvBinding } from "../../domain/workspace-binding.js";
import { EnvName } from "../../domain/env-name.js";
import type {
  WorkspaceBindingRepository,
  WorkspaceBindingUpsertInput,
} from "../../ports/workspace-binding-repository.js";

interface Row {
  id: string;
  scope_id: string;
  env_name: string;
  secret_name: string;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function toBinding(r: Row): WorkspaceEnvBinding {
  return {
    id: r.id,
    workspaceId: r.scope_id,
    envName: EnvName(r.env_name),
    secretName: r.secret_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
  };
}

const SCOPE_WORKSPACE = "workspace";

export class PostgresWorkspaceBindingRepository
  implements WorkspaceBindingRepository
{
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async listByWorkspace(workspaceId: string): Promise<WorkspaceEnvBinding[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, scope_id, env_name, secret_name, created_at, updated_at, created_by
      FROM env_bindings
      WHERE scope = ${SCOPE_WORKSPACE} AND scope_id = ${workspaceId}
      ORDER BY env_name ASC
    `;
    return rows.map(toBinding);
  }

  async upsert(
    input: WorkspaceBindingUpsertInput,
  ): Promise<WorkspaceEnvBinding> {
    const [row] = await this.sql<Row[]>`
      INSERT INTO env_bindings
        (scope, scope_id, env_name, secret_name, created_by)
      VALUES (
        ${SCOPE_WORKSPACE},
        ${input.workspaceId},
        ${input.envName as string},
        ${input.secretName},
        ${input.createdBy}
      )
      ON CONFLICT (scope, scope_id, env_name) DO UPDATE SET
        secret_name = EXCLUDED.secret_name,
        updated_at = now()
      RETURNING id, scope_id, env_name, secret_name, created_at, updated_at, created_by
    `;
    if (!row) throw new Error("env_bindings workspace upsert returned no row");
    return toBinding(row);
  }

  async delete(workspaceId: string, envName: EnvName): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM env_bindings
      WHERE scope = ${SCOPE_WORKSPACE}
        AND scope_id = ${workspaceId}
        AND env_name = ${envName as string}
    `;
    return (result.count ?? 0) > 0;
  }

  async findByNames(
    workspaceId: string,
    envNames: readonly string[],
  ): Promise<WorkspaceEnvBinding[]> {
    if (envNames.length === 0) return [];
    const rows = await this.sql<Row[]>`
      SELECT id, scope_id, env_name, secret_name, created_at, updated_at, created_by
      FROM env_bindings
      WHERE scope = ${SCOPE_WORKSPACE}
        AND scope_id = ${workspaceId}
        AND env_name = ANY(${this.sql.array(envNames as string[])})
    `;
    return rows.map(toBinding);
  }
}
