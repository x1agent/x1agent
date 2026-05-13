import type {
  CreateUploadUrlInput,
  CreateUploadUrlOutput,
  UploadStorage,
} from "../../ports/upload-storage.js";

/**
 * GCS adapter STUB — not yet implemented. The interface is shaped so a
 * real `@google-cloud/storage`-backed adapter can drop in without
 * touching callers. Throwing on every method keeps a half-wired
 * production config from silently swallowing uploads.
 *
 * To implement: mirror S3Storage with a GcsClientLike port (putObject,
 * getObject, headObject, deleteObject, getSignedUrl for resumable
 * uploads). The same key-prefix safety check applies.
 */
export class GcsStorage implements UploadStorage {
  constructor(public readonly bucket: string) {}

  async createUploadUrl(_input: CreateUploadUrlInput): Promise<CreateUploadUrlOutput> {
    throw new Error("GcsStorage: not yet implemented (v1 stub)");
  }
  async putObject(_key: string, _body: Uint8Array, _contentType: string): Promise<void> {
    throw new Error("GcsStorage: not yet implemented (v1 stub)");
  }
  async readHead(_key: string, _n: number): Promise<Uint8Array> {
    throw new Error("GcsStorage: not yet implemented (v1 stub)");
  }
  async readObject(_key: string): Promise<Uint8Array> {
    throw new Error("GcsStorage: not yet implemented (v1 stub)");
  }
  async statObject(_key: string): Promise<number | null> {
    throw new Error("GcsStorage: not yet implemented (v1 stub)");
  }
  async deleteObject(_key: string): Promise<void> {
    throw new Error("GcsStorage: not yet implemented (v1 stub)");
  }
}
