import type { UserId } from "@x1agent/kernel";
import type { Upload, UploadId, UploadStatus } from "../domain/upload.js";

export interface InsertUploadInput {
  id: UploadId;
  userId: UserId;
  sessionId: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  status: UploadStatus;
  createdAt: Date;
  expiresAt: Date;
}

export interface UploadRepository {
  insert(input: InsertUploadInput): Promise<Upload>;
  findById(id: UploadId): Promise<Upload | null>;
  markReady(id: UploadId, mime: string, sizeBytes: number): Promise<void>;
  markAttached(
    id: UploadId,
    sessionId: string,
    expiresAt: Date,
    attachedAt: Date,
  ): Promise<void>;
  markDeleted(id: UploadId): Promise<void>;
  /**
   * Atomically flip rows with `expires_at < now()` AND
   * `status IN ('pending','ready')` to `expired`. Returns the rows
   * whose storage objects the caller must now delete.
   */
  reapExpired(now: Date, limit: number): Promise<Upload[]>;
  /** Rows whose status is expired|deleted, ordered oldest first. */
  listForStorageDeletion(limit: number): Promise<Upload[]>;
  /** Hard-delete rows ≥ 90d past expiry. Returns the count removed. */
  hardDeleteOlderThan(cutoff: Date): Promise<number>;
  /** Count uploads created by the user since the supplied timestamp. */
  countRecentByUser(userId: UserId, since: Date): Promise<number>;
}
