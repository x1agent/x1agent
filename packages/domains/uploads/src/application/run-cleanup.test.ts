import { describe, it, expect } from "bun:test";
import { FixedClock, UserId } from "@x1agent/kernel";
import { UploadId } from "../domain/upload.js";
import { InMemoryUploadStorage } from "../adapters/in-memory-storage.js";
import { runUploadsCleanup } from "./run-cleanup.js";
import { InMemoryUploadRepository } from "./fakes.js";

const USER = UserId("9ac4f1d1-3b9c-4f1a-9e6b-1234567890ab");

async function makeUpload(
  uploads: InMemoryUploadRepository,
  storage: InMemoryUploadStorage,
  id: string,
  expiresAt: Date,
  createdAt: Date,
  status: "pending" | "ready" | "expired" | "deleted",
): Promise<void> {
  const upId = UploadId(id);
  const key = `uploads/2026/05/13/${id}.png`;
  await uploads.insert({
    id: upId,
    userId: USER,
    sessionId: null,
    filename: "x.png",
    mime: "image/png",
    sizeBytes: 4,
    storageKey: key,
    status: "pending",
    createdAt,
    expiresAt,
  });
  await storage.putObject(key, new Uint8Array([1, 2, 3, 4]), "image/png");
  if (status !== "pending") uploads.forceStatus(upId, status);
}

describe("runUploadsCleanup", () => {
  it("transitions pending+ready rows past their TTL to expired", async () => {
    const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
    const uploads = new InMemoryUploadRepository();
    const storage = new InMemoryUploadStorage();
    await makeUpload(
      uploads,
      storage,
      "11111111-1111-7111-8111-111111111111",
      new Date("2026-05-12T00:00:00Z"),
      new Date("2026-05-11T00:00:00Z"),
      "pending",
    );
    await makeUpload(
      uploads,
      storage,
      "22222222-2222-7222-8222-222222222222",
      new Date("2026-05-14T00:00:00Z"),
      new Date("2026-05-13T00:00:00Z"),
      "ready",
    );

    const r = await runUploadsCleanup({ uploads, storage, clock });
    expect(r.expired).toBe(1);
    // The expired row's storage object is deleted in the same tick.
    expect(r.objectsDeleted).toBe(1);
  });

  it("hard-deletes rows past the 90d horizon", async () => {
    const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
    const uploads = new InMemoryUploadRepository();
    const storage = new InMemoryUploadStorage();
    await makeUpload(
      uploads,
      storage,
      "33333333-3333-7333-8333-333333333333",
      new Date("2026-01-01T00:00:00Z"), // > 90d before now
      new Date("2025-12-01T00:00:00Z"),
      "expired",
    );
    const r = await runUploadsCleanup({ uploads, storage, clock });
    expect(r.hardDeleted).toBe(1);
    expect(uploads.rows.size).toBe(0);
  });

  it("is idempotent — second tick on the same state is a no-op", async () => {
    const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
    const uploads = new InMemoryUploadRepository();
    const storage = new InMemoryUploadStorage();
    await makeUpload(
      uploads,
      storage,
      "44444444-4444-7444-8444-444444444444",
      new Date("2026-05-12T00:00:00Z"),
      new Date("2026-05-11T00:00:00Z"),
      "pending",
    );
    await runUploadsCleanup({ uploads, storage, clock });
    const r2 = await runUploadsCleanup({ uploads, storage, clock });
    expect(r2.expired).toBe(0);
    expect(r2.objectsDeleted).toBe(0);
  });
});
