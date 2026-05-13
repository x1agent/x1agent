import type { Clock } from "@x1agent/kernel";
import type { UploadRepository } from "../ports/upload-repository.js";
import type { UploadStorage } from "../ports/upload-storage.js";

export interface CleanupResult {
  /** Rows transitioned pending|ready → expired this tick. */
  expired: number;
  /** Storage objects deleted this tick. */
  objectsDeleted: number;
  /** Rows hard-deleted this tick (≥ 90 d past expiry). */
  hardDeleted: number;
  errors: number;
}

export interface RunCleanupDeps {
  uploads: UploadRepository;
  storage: UploadStorage;
  clock: Clock;
  /** Per-tick batch size for each phase. Defaults to 200. */
  batchSize?: number;
  /** Days after expiry before the row is hard-deleted. Default 90. */
  hardDeleteAfterDays?: number;
}

/**
 * Idempotent + re-entrant cleanup sweep:
 *   Phase A — transition rows whose expires_at < now() and status ∈
 *             (pending, ready) to expired.
 *   Phase B — delete storage objects for rows in (expired, deleted).
 *   Phase C — hard-delete rows whose expires_at < now() - 90d.
 *
 * Each phase reads in batches and is safe to interleave with other
 * tickers — both phase A and the row-update in phase B use point
 * updates, so concurrent sweeps either contend cheaply or no-op.
 */
export async function runUploadsCleanup(
  deps: RunCleanupDeps,
): Promise<CleanupResult> {
  const batch = deps.batchSize ?? 200;
  const hardDeleteDays = deps.hardDeleteAfterDays ?? 90;
  const now = deps.clock.now();
  const result: CleanupResult = {
    expired: 0,
    objectsDeleted: 0,
    hardDeleted: 0,
    errors: 0,
  };

  // Phase A — transition expired rows.
  const expired = await deps.uploads.reapExpired(now, batch);
  result.expired = expired.length;

  // Phase B — delete storage objects for expired|deleted rows.
  const toDelete = await deps.uploads.listForStorageDeletion(batch);
  for (const row of toDelete) {
    try {
      await deps.storage.deleteObject(row.storageKey);
      result.objectsDeleted += 1;
    } catch (err) {
      result.errors += 1;
      console.error(
        "[uploads-cleanup] storage delete failed",
        row.id,
        err,
      );
    }
  }

  // Phase C — hard-delete rows older than the configured horizon.
  const cutoff = new Date(now.getTime() - hardDeleteDays * 24 * 60 * 60 * 1000);
  result.hardDeleted = await deps.uploads.hardDeleteOlderThan(cutoff);

  return result;
}
