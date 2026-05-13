import type { Clock, UserId } from "@x1agent/kernel";
import type { UploadsConfig } from "../domain/config.js";
import type { Upload, UploadId } from "../domain/upload.js";
import {
  UploadAlreadyCompletedError,
  UploadExpiredError,
  UploadMimeMismatchError,
  UploadMimeNotAllowedError,
  UploadNotFoundError,
  UploadNotOwnedError,
  UploadSizeMismatchError,
} from "../domain/errors.js";
import { sniffImageMime } from "../domain/mime-sniff.js";
import type { UploadRepository } from "../ports/upload-repository.js";
import type { UploadStorage } from "../ports/upload-storage.js";

export interface CompleteUploadDeps {
  uploads: UploadRepository;
  storage: UploadStorage;
  clock: Clock;
  config: UploadsConfig;
}

export interface CompleteUploadInput {
  uploadId: UploadId;
  /** The caller's user id — used for the ACL check. */
  userId: UserId;
}

/**
 * Promote a pending upload to ready after the bytes have landed:
 *
 *   1. Load the row; verify caller is the owner.
 *   2. Refuse to operate on rows that are not pending (idempotency +
 *      "already completed" → 409).
 *   3. Stat the storage object; compare to the declared size_bytes.
 *      Mismatch → delete the object, mark expired, raise
 *      `size_mismatch`.
 *   4. Read the first 32 bytes; MIME-sniff. If sniff is null or
 *      disagrees with the row's mime hint, delete + expire + raise
 *      `mime_mismatch`. Otherwise overwrite mime with the sniff result.
 *   5. Mark `ready`.
 *
 * Returns the updated row.
 */
export async function completeUpload(
  deps: CompleteUploadDeps,
  input: CompleteUploadInput,
): Promise<Upload> {
  const existing = await deps.uploads.findById(input.uploadId);
  if (!existing) throw new UploadNotFoundError();
  if (existing.userId !== input.userId) throw new UploadNotOwnedError();
  if (existing.status === "ready" || existing.status === "attached") {
    throw new UploadAlreadyCompletedError();
  }
  if (existing.status !== "pending") {
    // expired or deleted — surface as not-found so we don't leak.
    throw new UploadNotFoundError();
  }
  if (deps.clock.now() > existing.expiresAt) {
    throw new UploadExpiredError();
  }

  const size = await deps.storage.statObject(existing.storageKey);
  if (size === null) {
    // Nothing landed — caller raced complete() against the PUT.
    throw new UploadSizeMismatchError(existing.sizeBytes, 0);
  }
  if (size !== existing.sizeBytes) {
    await deps.storage.deleteObject(existing.storageKey);
    await deps.uploads.markDeleted(existing.id);
    throw new UploadSizeMismatchError(existing.sizeBytes, size);
  }

  const head = await deps.storage.readHead(existing.storageKey, 32);
  const sniffed = sniffImageMime(head);
  if (sniffed === null || sniffed !== existing.mime) {
    await deps.storage.deleteObject(existing.storageKey);
    await deps.uploads.markDeleted(existing.id);
    throw new UploadMimeMismatchError(existing.mime, sniffed);
  }
  if (!deps.config.allowedMimes.includes(sniffed)) {
    await deps.storage.deleteObject(existing.storageKey);
    await deps.uploads.markDeleted(existing.id);
    throw new UploadMimeNotAllowedError(sniffed);
  }

  await deps.uploads.markReady(existing.id, sniffed, size);
  return {
    ...existing,
    status: "ready",
    mime: sniffed,
    sizeBytes: size,
  };
}
