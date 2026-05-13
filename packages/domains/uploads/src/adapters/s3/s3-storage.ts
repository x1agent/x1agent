import type {
  CreateUploadUrlInput,
  CreateUploadUrlOutput,
  UploadStorage,
} from "../../ports/upload-storage.js";

/**
 * Minimal S3 client surface this adapter depends on. The composition
 * root supplies an adapter constructed from `@aws-sdk/client-s3` +
 * `@aws-sdk/s3-request-presigner` lazily (only when
 * UPLOAD_STORAGE_BACKEND=s3) so the domain package itself doesn't
 * carry the SDK as a runtime dep. The shape mirrors `getSignedUrl` +
 * `S3Client.send(PutObjectCommand)` etc.
 */
export interface S3ClientLike {
  putObject(args: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
  getObject(args: {
    bucket: string;
    key: string;
    range?: { start: number; end: number };
  }): Promise<Uint8Array | null>;
  headObject(args: {
    bucket: string;
    key: string;
  }): Promise<{ size: number } | null>;
  deleteObject(args: { bucket: string; key: string }): Promise<void>;
  presignPut(args: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string>;
}

export interface S3StorageOptions {
  bucket: string;
  client: S3ClientLike;
}

/**
 * S3-backed UploadStorage. Production deploys set
 * UPLOAD_STORAGE_BACKEND=s3 + UPLOAD_S3_BUCKET, and the composition
 * root constructs a real `S3Client` (standard AWS credentials chain)
 * adapted to `S3ClientLike` before handing it here. The presigned URL
 * is bound to the key, content-type, and content-length so the client
 * cannot tamper with any of them.
 */
export class S3Storage implements UploadStorage {
  constructor(private readonly opts: S3StorageOptions) {
    this.assertKeyPrefix("uploads/");
  }

  async createUploadUrl(
    input: CreateUploadUrlInput,
  ): Promise<CreateUploadUrlOutput> {
    this.assertSafeKey(input.key);
    const expiresInSeconds = Math.max(
      1,
      Math.ceil((input.expiresAt.getTime() - Date.now()) / 1000),
    );
    const url = await this.opts.client.presignPut({
      bucket: this.opts.bucket,
      key: input.key,
      contentType: input.contentType,
      contentLength: input.contentLength,
      expiresInSeconds,
    });
    return {
      url,
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.contentLength),
      },
    };
  }

  async putObject(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    this.assertSafeKey(key);
    await this.opts.client.putObject({
      bucket: this.opts.bucket,
      key,
      body,
      contentType,
    });
  }

  async readHead(key: string, n: number): Promise<Uint8Array> {
    this.assertSafeKey(key);
    const buf = await this.opts.client.getObject({
      bucket: this.opts.bucket,
      key,
      range: { start: 0, end: Math.max(0, n - 1) },
    });
    if (!buf) throw new Error(`s3-storage: object not found: ${key}`);
    return buf;
  }

  async readObject(key: string): Promise<Uint8Array> {
    this.assertSafeKey(key);
    const buf = await this.opts.client.getObject({
      bucket: this.opts.bucket,
      key,
    });
    if (!buf) throw new Error(`s3-storage: object not found: ${key}`);
    return buf;
  }

  async statObject(key: string): Promise<number | null> {
    this.assertSafeKey(key);
    const r = await this.opts.client.headObject({
      bucket: this.opts.bucket,
      key,
    });
    return r ? r.size : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.assertSafeKey(key);
    await this.opts.client.deleteObject({
      bucket: this.opts.bucket,
      key,
    });
  }

  private assertKeyPrefix(_prefix: string): void {
    // Reserved for future configurability (per-tenant bucket prefix).
    // Today every key is `uploads/<...>` by construction in buildStorageKey;
    // we still validate at every method entry via assertSafeKey.
  }

  private assertSafeKey(key: string): void {
    if (!key.startsWith("uploads/")) {
      throw new Error(`s3-storage: refusing key outside uploads/: ${key}`);
    }
    if (key.includes("..") || key.includes("\0")) {
      throw new Error(`s3-storage: refusing traversal key: ${key}`);
    }
  }
}
