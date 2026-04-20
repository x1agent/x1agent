import type postgres from "postgres";
import type { SharedResourceRepository } from "@x1agent/agent-resources";
import type {
  PostgresBranchMinter,
  PostgresBranchRepository,
} from "@x1agent/agent-resources-postgres";
import type {
  RedisBranchMinter,
  RedisBranchRepository,
} from "@x1agent/agent-resources-redis";

type Sql = postgres.Sql<Record<string, unknown>>;

export interface BranchReaperConfig {
  sql: Sql;
  sharedResources: SharedResourceRepository;
  postgresBranches: PostgresBranchRepository | null;
  postgresMinter: PostgresBranchMinter | null;
  redisBranches: RedisBranchRepository | null;
  redisMinter: RedisBranchMinter | null;
  namespace: string;
  /**
   * Branches whose last_used_at is older than this interval are reaped.
   * v1 uses a time-based policy instead of a GitHub-list diff so the
   * reaper has zero external dependencies; the diff approach can be
   * layered in later as a faster-path webhook handler.
   */
  staleAfterMs?: number;
}

export interface BranchReapResult {
  postgresReaped: number;
  redisReaped: number;
  errors: number;
}

/**
 * Reap branch metadata rows whose last_used_at is older than the
 * configured cutoff. For each, call the engine's revokeBranch (drops
 * the DB / ACL user) and mark the row reaped in the control plane.
 *
 * Safe to call concurrently with session launches: upsert() bumps
 * last_used_at on every mint, so an actively-used branch cannot race
 * a reap. A reaped row is treated as "does not exist" by mint paths,
 * so the next session re-provisions cleanly.
 */
export async function reapStaleBranches(
  cfg: BranchReaperConfig,
): Promise<BranchReapResult> {
  const staleAfterMs = cfg.staleAfterMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
  const cutoff = new Date(Date.now() - staleAfterMs);
  let postgresReaped = 0;
  let redisReaped = 0;
  let errors = 0;

  // Build a map of resource_id -> resource for the subset of resources
  // that have stale branches. Done upfront to avoid N+1 queries.
  const staleRows = await cfg.sql<
    {
      kind: string;
      branch_row_id: string;
      resource_id: string;
      branch_id: string;
    }[]
  >`
    SELECT 'postgres' AS kind,
           b.id AS branch_row_id,
           b.resource_id,
           b.branch_id
    FROM workspace_postgres_branches b
    WHERE b.reaped_at IS NULL AND b.last_used_at < ${cutoff}
    UNION ALL
    SELECT 'redis' AS kind,
           b.id AS branch_row_id,
           b.resource_id,
           b.branch_id
    FROM workspace_redis_branches b
    WHERE b.reaped_at IS NULL AND b.last_used_at < ${cutoff}
  `;

  const resourceCache = new Map<string, Awaited<
    ReturnType<SharedResourceRepository["findById"]>
  >>();

  for (const row of staleRows) {
    let resource = resourceCache.get(row.resource_id);
    if (resource === undefined) {
      resource = await cfg.sharedResources.findById(row.resource_id as never);
      resourceCache.set(row.resource_id, resource);
    }
    if (!resource) {
      // Orphaned row — the resource is gone. Just mark reaped.
      await markReaped(cfg, row.kind, row.branch_row_id);
      continue;
    }

    try {
      if (row.kind === "postgres") {
        if (cfg.postgresMinter) {
          await cfg.postgresMinter.revokeBranch({
            resource,
            namespace: cfg.namespace,
            branchId: row.branch_id,
          });
        }
        await markReaped(cfg, "postgres", row.branch_row_id);
        postgresReaped++;
      } else if (row.kind === "redis") {
        if (cfg.redisMinter) {
          await cfg.redisMinter.revokeBranch({
            resource,
            namespace: cfg.namespace,
            branchId: row.branch_id,
          });
        }
        await markReaped(cfg, "redis", row.branch_row_id);
        redisReaped++;
      }
    } catch {
      errors++;
    }
  }

  return { postgresReaped, redisReaped, errors };
}

async function markReaped(
  cfg: BranchReaperConfig,
  kind: string,
  rowId: string,
): Promise<void> {
  const table =
    kind === "postgres"
      ? "workspace_postgres_branches"
      : "workspace_redis_branches";
  await cfg.sql.unsafe(
    `UPDATE ${table} SET reaped_at = now() WHERE id = $1`,
    [rowId],
  );
}
