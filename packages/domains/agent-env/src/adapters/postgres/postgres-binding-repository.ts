import type postgres from "postgres";
import type { AgentEnvBinding } from "../../domain/binding.js";
import { EnvName } from "../../domain/env-name.js";
import type {
  BindingRepository,
  BindingUpsertInput,
} from "../../ports/binding-repository.js";

interface BindingRow {
  id: string;
  scope_id: string;
  env_name: string;
  secret_name: string;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function rowToBinding(row: BindingRow): AgentEnvBinding {
  return {
    id: row.id,
    agentId: row.scope_id,
    envName: EnvName(row.env_name),
    secretName: row.secret_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

const SCOPE_AGENT = "agent";

export class PostgresBindingRepository implements BindingRepository {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async listByAgent(agentId: string): Promise<AgentEnvBinding[]> {
    const rows = await this.sql<BindingRow[]>`
      SELECT id, scope_id, env_name, secret_name, created_at, updated_at, created_by
      FROM env_bindings
      WHERE scope = ${SCOPE_AGENT} AND scope_id = ${agentId}
      ORDER BY env_name ASC
    `;
    return rows.map(rowToBinding);
  }

  async upsert(input: BindingUpsertInput): Promise<AgentEnvBinding> {
    const [row] = await this.sql<BindingRow[]>`
      INSERT INTO env_bindings
        (scope, scope_id, env_name, secret_name, created_by)
      VALUES (
        ${SCOPE_AGENT},
        ${input.agentId},
        ${input.envName as string},
        ${input.secretName},
        ${input.createdBy}
      )
      ON CONFLICT (scope, scope_id, env_name) DO UPDATE SET
        secret_name = EXCLUDED.secret_name,
        updated_at = now()
      RETURNING id, scope_id, env_name, secret_name, created_at, updated_at, created_by
    `;
    if (!row) throw new Error("env_bindings upsert returned no row");
    return rowToBinding(row);
  }

  async delete(agentId: string, envName: EnvName): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM env_bindings
      WHERE scope = ${SCOPE_AGENT}
        AND scope_id = ${agentId}
        AND env_name = ${envName as string}
    `;
    return (result.count ?? 0) > 0;
  }

  async agentHasAny(agentId: string): Promise<boolean> {
    const [row] = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM env_bindings
        WHERE scope = ${SCOPE_AGENT} AND scope_id = ${agentId}
      ) AS exists
    `;
    return row?.exists === true;
  }
}
