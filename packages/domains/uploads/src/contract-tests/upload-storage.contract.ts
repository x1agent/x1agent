import { describe, it, expect } from "bun:test";
import type { UploadStorage } from "../ports/upload-storage.js";

export interface UploadStorageFixture {
  name: string;
  /** Build a fresh, isolated adapter per test. */
  factory: () => Promise<UploadStorage> | UploadStorage;
  /** Optional teardown (rm temp dir, etc.). */
  cleanup?: (storage: UploadStorage) => Promise<void> | void;
}

/**
 * Contract suite every UploadStorage adapter satisfies. Adapters call
 * this from their own package test file passing a fixture.
 *
 * The contract exercises every method on the port:
 *   - createUploadUrl returns a non-empty URL + PUT method
 *   - putObject + statObject roundtrip the byte length
 *   - readHead + readObject return the bytes
 *   - deleteObject removes the object idempotently
 *   - non-existent objects: stat returns null, delete is a no-op
 */
export function runUploadStorageContract(fx: UploadStorageFixture) {
  const TEST_KEY = "uploads/2026/05/13/00000000-0000-7000-8000-000000000000.png";
  const PAYLOAD = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  describe(`UploadStorage contract — ${fx.name}`, () => {
    it("statObject returns null for missing objects", async () => {
      const s = await fx.factory();
      try {
        expect(await s.statObject(TEST_KEY)).toBeNull();
      } finally {
        await fx.cleanup?.(s);
      }
    });

    it("putObject + statObject roundtrip size", async () => {
      const s = await fx.factory();
      try {
        await s.putObject(TEST_KEY, PAYLOAD, "image/png");
        expect(await s.statObject(TEST_KEY)).toBe(PAYLOAD.byteLength);
      } finally {
        await fx.cleanup?.(s);
      }
    });

    it("readHead returns the prefix; readObject returns all bytes", async () => {
      const s = await fx.factory();
      try {
        await s.putObject(TEST_KEY, PAYLOAD, "image/png");
        const head = await s.readHead(TEST_KEY, 3);
        expect(Array.from(head)).toEqual([1, 2, 3]);
        const all = await s.readObject(TEST_KEY);
        expect(Array.from(all)).toEqual(Array.from(PAYLOAD));
      } finally {
        await fx.cleanup?.(s);
      }
    });

    it("deleteObject removes the object; second call is a no-op", async () => {
      const s = await fx.factory();
      try {
        await s.putObject(TEST_KEY, PAYLOAD, "image/png");
        await s.deleteObject(TEST_KEY);
        expect(await s.statObject(TEST_KEY)).toBeNull();
        // idempotent
        await s.deleteObject(TEST_KEY);
      } finally {
        await fx.cleanup?.(s);
      }
    });

    it("createUploadUrl returns a non-empty URL + PUT method", async () => {
      const s = await fx.factory();
      try {
        const out = await s.createUploadUrl({
          key: TEST_KEY,
          contentType: "image/png",
          contentLength: PAYLOAD.byteLength,
          expiresAt: new Date(Date.now() + 60_000),
        });
        expect(out.method).toBe("PUT");
        expect(out.url.length).toBeGreaterThan(0);
      } finally {
        await fx.cleanup?.(s);
      }
    });
  });
}
