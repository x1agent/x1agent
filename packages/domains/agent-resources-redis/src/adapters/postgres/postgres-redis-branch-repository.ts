import type postgres from "postgres";
import { SharedResourceId } from "@x1agent/agent-resources";
import {
  RedisBranchRowId,
  type RedisBranch,
} from "../../domain/redis-branch.js";
import type {
  FindRedisBranchInput,
  RedisBranchRepository,
  UpsertRedisBranchInput,
} from "../../ports/redis-branch-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  resource_id: string;
  repo_full_name: string;
  branch_name: string;
  branch_id: string;
  last_used_at: Date | string;
  reaped_at: Date | string | null;
  created_at: Date | string;
}

function toBranch(r: Row): RedisBranch {
  return {
    id: RedisBranchRowId(r.id),
    resourceId: SharedResourceId(r.resource_id),
    repoFullName: r.repo_full_name,
    branchName: r.branch_name,
    branchId: r.branch_id,
    lastUsedAt: new Date(r.last_used_at),
    reapedAt: r.reaped_at ? new Date(r.reaped_at) : null,
    createdAt: new Date(r.created_at),
  };
}

const SELECT = `
  id, resource_id, repo_full_name, branch_name, branch_id,
  last_used_at, reaped_at, created_at
`;

export class PostgresRedisBranchRepository implements RedisBranchRepository {
  constructor(private readonly sql: Sql) {}

  async find(input: FindRedisBranchInput): Promise<RedisBranch | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM workspace_redis_branches
      WHERE resource_id = ${input.resourceId}
        AND repo_full_name = ${input.repoFullName}
        AND branch_name = ${input.branchName}
        AND reaped_at IS NULL
    `;
    return rows[0] ? toBranch(rows[0]) : null;
  }

  async upsert(input: UpsertRedisBranchInput): Promise<RedisBranch> {
    const rows = await this.sql<Row[]>`
      INSERT INTO workspace_redis_branches
        (resource_id, repo_full_name, branch_name, branch_id)
      VALUES
        (${input.resourceId}, ${input.repoFullName},
         ${input.branchName}, ${input.branchId})
      ON CONFLICT (resource_id, repo_full_name, branch_name)
      DO UPDATE SET last_used_at = now()
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toBranch(rows[0]!);
  }

  async listActiveByResource(
    resourceId: SharedResourceId,
  ): Promise<readonly RedisBranch[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM workspace_redis_branches
      WHERE resource_id = ${resourceId} AND reaped_at IS NULL
      ORDER BY created_at ASC
    `;
    return rows.map(toBranch);
  }

  async markReaped(id: RedisBranchRowId): Promise<void> {
    await this.sql`
      UPDATE workspace_redis_branches
      SET reaped_at = now()
      WHERE id = ${id}
    `;
  }
}
