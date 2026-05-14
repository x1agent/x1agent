// Domain
export * from "./domain/upload.js";
export * from "./domain/errors.js";
export * from "./domain/config.js";
export * from "./domain/mime-sniff.js";

// Ports
export type {
  UploadRepository,
  InsertUploadInput,
} from "./ports/upload-repository.js";
export type {
  UploadStorage,
  CreateUploadUrlInput,
  CreateUploadUrlOutput,
} from "./ports/upload-storage.js";
export type { RateLimiter } from "./ports/rate-limiter.js";
export { uploadInitKey } from "./ports/rate-limiter.js";

// Application
export {
  initUpload,
  type InitUploadDeps,
  type InitUploadInput,
  type InitUploadResult,
} from "./application/init-upload.js";
export {
  completeUpload,
  type CompleteUploadDeps,
  type CompleteUploadInput,
} from "./application/complete-upload.js";
export { getOwnedUpload } from "./application/get-upload.js";
export { deleteUpload } from "./application/delete-upload.js";
export {
  runUploadsCleanup,
  type CleanupResult,
  type RunCleanupDeps,
} from "./application/run-cleanup.js";

// Adapters
export { LocalDiskStorage } from "./adapters/local-disk/local-disk-storage.js";
export type { LocalDiskStorageOptions } from "./adapters/local-disk/local-disk-storage.js";
export { S3Storage } from "./adapters/s3/s3-storage.js";
export type {
  S3ClientLike,
  S3StorageOptions,
} from "./adapters/s3/s3-storage.js";
export { GcsStorage } from "./adapters/gcs/gcs-storage.js";
export { InMemoryUploadStorage } from "./adapters/in-memory-storage.js";
export { InMemoryUploadRepository } from "./application/fakes.js";
export { PostgresUploadRepository } from "./adapters/postgres/postgres-upload-repository.js";
export { InMemoryRateLimiter } from "./adapters/in-memory-rate-limiter.js";

// HTTP
export {
  createUploadRoutes,
  type UploadRoutesConfig,
} from "./adapters/hono/routes.js";

// Contract tests
export { runUploadStorageContract } from "./contract-tests/upload-storage.contract.js";
export type { UploadStorageFixture } from "./contract-tests/upload-storage.contract.js";
