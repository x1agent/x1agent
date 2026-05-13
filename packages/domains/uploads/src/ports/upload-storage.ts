/**
 * Block-storage adapter contract for image uploads. Every implementation
 * (LocalDiskStorage, S3Storage, future GCSStorage) must satisfy this
 * shape so callers in the application layer never reach for an
 * adapter-specific API. The contract-test suite in
 * `contract-tests/upload-storage.contract.ts` exercises every method
 * against a concrete adapter.
 *
 * `key` is always the time-bucketed `uploads/YYYY/MM/DD/<id>.<ext>`
 * path produced by `buildStorageKey`. Adapters MUST refuse keys that
 * try to escape the prefix (`..`, absolute paths, etc.) — see
 * LocalDiskStorage for the reference check.
 */
export interface UploadStorage {
  /**
   * Issue a short-lived URL the client can PUT bytes to. The
   * implementation chooses presigned S3 vs. an HMAC-signed local
   * endpoint; callers don't distinguish.
   */
  createUploadUrl(input: CreateUploadUrlInput): Promise<CreateUploadUrlOutput>;

  /**
   * Persist bytes at `key`. Used by the local-disk signed-PUT route
   * (the api process is the only writer in dev) and by adapter-level
   * tests. S3 in production is written through the presigned URL by the
   * browser; this method is still implemented as a server-side fallback.
   */
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;

  /**
   * Read the first `n` bytes of an object for MIME sniffing. Returns
   * the actual byte count read (may be < n if the object is smaller).
   */
  readHead(key: string, n: number): Promise<Uint8Array>;

  /** Stream the full object body. */
  readObject(key: string): Promise<Uint8Array>;

  /** Return the object size in bytes, or null if the object is missing. */
  statObject(key: string): Promise<number | null>;

  /** Idempotent delete — succeeds whether the object exists or not. */
  deleteObject(key: string): Promise<void>;
}

export interface CreateUploadUrlInput {
  key: string;
  contentType: string;
  contentLength: number;
  /** When the URL stops being valid. */
  expiresAt: Date;
}

export interface CreateUploadUrlOutput {
  /** Absolute URL the client should PUT bytes to. */
  url: string;
  /** HTTP method (always PUT in v1, kept for forward-compat). */
  method: "PUT";
  /** Headers the client must echo on the PUT (signed by the adapter). */
  headers: Record<string, string>;
}
