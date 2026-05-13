import type { Clock, UserId } from "@x1agent/kernel";
import { ValidationError } from "@x1agent/kernel";
import type { UploadsConfig } from "../domain/config.js";
import {
  buildStorageKey,
  sanitizeFilename,
  type Upload,
  type UploadId,
} from "../domain/upload.js";
import {
  UploadMimeNotAllowedError,
  UploadTooLargeError,
} from "../domain/errors.js";
import { extensionFor } from "../domain/mime-sniff.js";
import type { UploadRepository } from "../ports/upload-repository.js";
import type {
  CreateUploadUrlOutput,
  UploadStorage,
} from "../ports/upload-storage.js";

export interface InitUploadInput {
  userId: UserId;
  filename: string;
  mimeHint: string;
  sizeBytes: number;
  /** Optional session attachment — null for Case A pre-session uploads. */
  sessionId: string | null;
}

export interface InitUploadResult {
  upload: Upload;
  uploadUrl: CreateUploadUrlOutput;
}

export interface InitUploadDeps {
  uploads: UploadRepository;
  storage: UploadStorage;
  clock: Clock;
  config: UploadsConfig;
  /** Returns a fresh v4/v7 UUID. Caller-supplied so tests can pin it. */
  uuid: () => UploadId;
}

/**
 * Create a pending upload row + a short-lived URL the client can PUT
 * bytes to. Caller is responsible for rate-limiting BEFORE calling
 * this — the route adapter does that against the RateLimiter port.
 *
 * Validation order matches the ticket's negative cases:
 *   1. size > UPLOAD_MAX_BYTES → `upload_too_large` (400)
 *   2. mimeHint not in allow list → `mime_not_allowed` (400)
 *   3. unsupported extension → `mime_not_allowed`
 * The MIME hint is advisory; the authoritative check happens in
 * `complete-upload.ts` after the bytes land.
 */
export async function initUpload(
  deps: InitUploadDeps,
  input: InitUploadInput,
): Promise<InitUploadResult> {
  if (input.sizeBytes <= 0) {
    throw new ValidationError("size_bytes", "must be positive");
  }
  if (input.sizeBytes > deps.config.maxBytes) {
    throw new UploadTooLargeError(deps.config.maxBytes);
  }
  if (!deps.config.allowedMimes.includes(input.mimeHint)) {
    throw new UploadMimeNotAllowedError(input.mimeHint);
  }
  const ext = extensionFor(input.mimeHint);
  if (!ext) throw new UploadMimeNotAllowedError(input.mimeHint);

  const id = deps.uuid();
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + deps.config.pendingTtlMs);
  const storageKey = buildStorageKey(id, ext, now);
  const filename = sanitizeFilename(input.filename, ext);

  const upload = await deps.uploads.insert({
    id,
    userId: input.userId,
    sessionId: input.sessionId,
    filename,
    mime: input.mimeHint,
    sizeBytes: input.sizeBytes,
    storageKey,
    status: "pending",
    createdAt: now,
    expiresAt,
  });

  const uploadUrl = await deps.storage.createUploadUrl({
    key: storageKey,
    contentType: input.mimeHint,
    contentLength: input.sizeBytes,
    expiresAt: new Date(now.getTime() + deps.config.signedUrlTtlMs),
  });

  return { upload, uploadUrl };
}
