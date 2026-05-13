import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Clock } from "@x1agent/kernel";
import type {
  CreateUploadUrlInput,
  CreateUploadUrlOutput,
  UploadStorage,
} from "../../ports/upload-storage.js";

export interface LocalDiskStorageOptions {
  /** Absolute filesystem root that contains every uploads/YYYY/... key. */
  rootDir: string;
  /** Base URL the signed-PUT endpoint is mounted on (no trailing slash). */
  publicBaseUrl: string;
  /** Shared HMAC secret for signing the local upload URLs. */
  hmacSecret: string;
  clock: Clock;
}

/**
 * Filesystem-backed UploadStorage for dev / on-prem deploys.
 *
 * Layout: every key is resolved relative to `rootDir`. Keys must start
 * with `uploads/` and never contain `..` or absolute path fragments —
 * the resolved path is verified to stay inside `rootDir` before any
 * file operation. This is the path-traversal guardrail; mirrors the
 * S3 adapter's bucket-prefix enforcement.
 *
 * Upload URLs are POST-signed HMAC tokens:
 *
 *   GET/PUT  {publicBaseUrl}/{key}?exp=<unix>&len=<bytes>&ct=<mime>&sig=<hex>
 *
 * The api process verifies the signature on the raw-PUT route before
 * writing bytes. The expiry is a unix timestamp (seconds since epoch);
 * tampering with any signed parameter breaks the HMAC.
 */
export class LocalDiskStorage implements UploadStorage {
  constructor(private readonly opts: LocalDiskStorageOptions) {}

  async createUploadUrl(
    input: CreateUploadUrlInput,
  ): Promise<CreateUploadUrlOutput> {
    const expSec = Math.floor(input.expiresAt.getTime() / 1000);
    const sig = this.sign({
      key: input.key,
      exp: expSec,
      len: input.contentLength,
      ct: input.contentType,
    });
    const qs = new URLSearchParams({
      exp: String(expSec),
      len: String(input.contentLength),
      ct: input.contentType,
      sig,
    });
    // The signed-PUT URL exposes the upload id (not the storage key)
    // so the route signature is the same as the rest of the
    // /api/uploads/:id/* surface. The api process re-derives the
    // storage_key from the row before verifying the HMAC, so any
    // request that doesn't match the row's bound key fails the sig
    // check.
    const id = idFromKey(input.key);
    return {
      url: `${this.opts.publicBaseUrl}/${id}/raw?${qs.toString()}`,
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
    _contentType: string,
  ): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async readHead(key: string, n: number): Promise<Uint8Array> {
    const path = this.resolveKey(key);
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async readObject(key: string): Promise<Uint8Array> {
    return await readFile(this.resolveKey(key));
  }

  async statObject(key: string): Promise<number | null> {
    try {
      const s = await stat(this.resolveKey(key));
      return s.size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  /**
   * Verify a presigned upload token. Throws if the signature, expiry,
   * declared length, or content-type doesn't match. Returns the parsed
   * params on success. Used by the raw-PUT route adapter.
   */
  verifyUploadToken(params: {
    key: string;
    expSec: number;
    len: number;
    contentType: string;
    sig: string;
  }): void {
    const now = Math.floor(this.opts.clock.now().getTime() / 1000);
    if (params.expSec < now) {
      throw new Error("upload_url_expired");
    }
    const expected = this.sign({
      key: params.key,
      exp: params.expSec,
      len: params.len,
      ct: params.contentType,
    });
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(params.sig, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("upload_url_invalid_signature");
    }
  }

  private sign(payload: {
    key: string;
    exp: number;
    len: number;
    ct: string;
  }): string {
    const msg = `${payload.key}\n${payload.exp}\n${payload.len}\n${payload.ct}`;
    return createHmac("sha256", this.opts.hmacSecret).update(msg).digest("hex");
  }

  /**
   * Extract the upload id from a storage key — exposed for the route
   * adapter so it doesn't have to re-derive the convention.
   */
  static idFromKey(key: string): string {
    return idFromKey(key);
  }

  private resolveKey(key: string): string {
    if (!key.startsWith("uploads/")) {
      throw new Error(`local-disk-storage: refusing key outside uploads/: ${key}`);
    }
    if (key.includes("\0") || key.split("/").some((p) => p === "..")) {
      throw new Error(`local-disk-storage: refusing traversal key: ${key}`);
    }
    const root = resolve(this.opts.rootDir);
    const full = resolve(root, key);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`local-disk-storage: key escapes root: ${key}`);
    }
    return full;
  }
}

function idFromKey(key: string): string {
  // key = uploads/YYYY/MM/DD/<id>.<ext>
  const last = key.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}
