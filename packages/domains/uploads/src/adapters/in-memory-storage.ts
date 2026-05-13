import type {
  CreateUploadUrlInput,
  CreateUploadUrlOutput,
  UploadStorage,
} from "../ports/upload-storage.js";

/**
 * In-memory UploadStorage. Used by:
 *   - contract tests (cheap baseline);
 *   - unit tests of the application layer;
 *   - the in-process upload PUT path in integration tests that don't
 *     want to round-trip through the filesystem.
 *
 * NOT for production — even single-process state evaporates on restart.
 */
export class InMemoryUploadStorage implements UploadStorage {
  private readonly store = new Map<string, Uint8Array>();

  async createUploadUrl(
    input: CreateUploadUrlInput,
  ): Promise<CreateUploadUrlOutput> {
    return {
      url: `memory://${input.key}`,
      method: "PUT",
      headers: { "Content-Type": input.contentType },
    };
  }

  async putObject(key: string, body: Uint8Array): Promise<void> {
    this.store.set(key, new Uint8Array(body));
  }

  async readHead(key: string, n: number): Promise<Uint8Array> {
    const buf = this.store.get(key);
    if (!buf) throw new Error(`memory-storage: object not found: ${key}`);
    return buf.subarray(0, Math.min(n, buf.byteLength));
  }

  async readObject(key: string): Promise<Uint8Array> {
    const buf = this.store.get(key);
    if (!buf) throw new Error(`memory-storage: object not found: ${key}`);
    return buf;
  }

  async statObject(key: string): Promise<number | null> {
    const buf = this.store.get(key);
    return buf ? buf.byteLength : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }
}
