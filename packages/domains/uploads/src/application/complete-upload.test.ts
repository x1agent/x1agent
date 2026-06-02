import { describe, it, expect, beforeEach } from "bun:test";
import { FixedClock, UserId } from "@x1agent/kernel";
import { DEFAULT_UPLOADS_CONFIG } from "../domain/config.js";
import { UploadId } from "../domain/upload.js";
import {
  UploadAlreadyCompletedError,
  UploadExpiredError,
  UploadMimeMismatchError,
  UploadNotFoundError,
  UploadNotOwnedError,
  UploadSizeMismatchError,
} from "../domain/errors.js";
import { InMemoryUploadStorage } from "../adapters/in-memory-storage.js";
import { completeUpload } from "./complete-upload.js";
import { initUpload } from "./init-upload.js";
import { InMemoryUploadRepository } from "./fakes.js";

const USER = UserId("9ac4f1d1-3b9c-4f1a-9e6b-1234567890ab");
const OTHER = UserId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

function pngBytes(totalLen: number): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(Math.max(totalLen, head.length));
  out.set(head, 0);
  return out.subarray(0, totalLen);
}

async function seed() {
  const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
  const uploads = new InMemoryUploadRepository();
  const storage = new InMemoryUploadStorage();
  const deps = {
    uploads,
    storage,
    clock,
    config: DEFAULT_UPLOADS_CONFIG,
    uuid: () => UploadId("11111111-1111-7111-8111-111111111111"),
  };
  const { upload } = await initUpload(deps, {
    userId: USER,
    filename: "hello.png",
    mimeHint: "image/png",
    sizeBytes: 16,
    sessionId: null,
  });
  return { ...deps, upload };
}

describe("completeUpload", () => {
  it("marks ready when bytes + sniff match the hint", async () => {
    const d = await seed();
    await d.storage.putObject(d.upload.storageKey, pngBytes(16), "image/png");
    const out = await completeUpload(d, {
      uploadId: d.upload.id,
      userId: USER,
    });
    expect(out.status).toBe("ready");
    expect(out.mime).toBe("image/png");
  });

  it("rejects a foreign user with not_found (no leak)", async () => {
    const d = await seed();
    await d.storage.putObject(d.upload.storageKey, pngBytes(16), "image/png");
    await expect(
      completeUpload(d, { uploadId: d.upload.id, userId: OTHER }),
    ).rejects.toBeInstanceOf(UploadNotOwnedError);
  });

  it("rejects size mismatch — deletes object, soft-deletes row", async () => {
    const d = await seed();
    // 16 declared, 8 actual
    await d.storage.putObject(d.upload.storageKey, pngBytes(8), "image/png");
    await expect(
      completeUpload(d, { uploadId: d.upload.id, userId: USER }),
    ).rejects.toBeInstanceOf(UploadSizeMismatchError);
    expect(await d.storage.statObject(d.upload.storageKey)).toBeNull();
    expect(d.uploads.rows.get(d.upload.id)?.status).toBe("deleted");
  });

  it("rejects MIME mismatch (PDF body claiming PNG)", async () => {
    const d = await seed();
    const pdf = new Uint8Array(16);
    pdf.set([0x25, 0x50, 0x44, 0x46], 0); // %PDF
    await d.storage.putObject(d.upload.storageKey, pdf, "image/png");
    await expect(
      completeUpload(d, { uploadId: d.upload.id, userId: USER }),
    ).rejects.toBeInstanceOf(UploadMimeMismatchError);
    expect(d.uploads.rows.get(d.upload.id)?.status).toBe("deleted");
  });

  it("rejects expired uploads", async () => {
    const d = await seed();
    await d.storage.putObject(d.upload.storageKey, pngBytes(16), "image/png");
    d.clock.advance(25 * 60 * 60 * 1000); // 25 hours
    await expect(
      completeUpload(d, { uploadId: d.upload.id, userId: USER }),
    ).rejects.toBeInstanceOf(UploadExpiredError);
  });

  it("rejects double-complete", async () => {
    const d = await seed();
    await d.storage.putObject(d.upload.storageKey, pngBytes(16), "image/png");
    await completeUpload(d, { uploadId: d.upload.id, userId: USER });
    await expect(
      completeUpload(d, { uploadId: d.upload.id, userId: USER }),
    ).rejects.toBeInstanceOf(UploadAlreadyCompletedError);
  });

  it("404s on unknown ids", async () => {
    const d = await seed();
    await expect(
      completeUpload(d, {
        uploadId: UploadId("22222222-2222-7222-8222-222222222222"),
        userId: USER,
      }),
    ).rejects.toBeInstanceOf(UploadNotFoundError);
  });

  it("completes an HTML upload — sniffs the leading '<'", async () => {
    const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
    const uploads = new InMemoryUploadRepository();
    const storage = new InMemoryUploadStorage();
    const deps = {
      uploads,
      storage,
      clock,
      config: DEFAULT_UPLOADS_CONFIG,
      uuid: () => UploadId("55555555-5555-7555-8555-555555555555"),
    };
    const { upload } = await initUpload(deps, {
      userId: USER,
      filename: "report.html",
      mimeHint: "text/html",
      sizeBytes: 32,
      sessionId: null,
    });
    const bytes = new Uint8Array(32);
    bytes.set(
      Array.from("<!doctype html><html></html>").map((c) => c.charCodeAt(0)),
      0,
    );
    await storage.putObject(upload.storageKey, bytes, "text/html");
    const out = await completeUpload(deps, {
      uploadId: upload.id,
      userId: USER,
    });
    expect(out.status).toBe("ready");
    expect(out.mime).toBe("text/html");
  });

  it("completes a JSON upload via the textlike trust path (no magic bytes)", async () => {
    const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
    const uploads = new InMemoryUploadRepository();
    const storage = new InMemoryUploadStorage();
    const deps = {
      uploads,
      storage,
      clock,
      config: DEFAULT_UPLOADS_CONFIG,
      uuid: () => UploadId("66666666-6666-7666-8666-666666666666"),
    };
    const { upload } = await initUpload(deps, {
      userId: USER,
      filename: "data.json",
      mimeHint: "application/json",
      sizeBytes: 16,
      sessionId: null,
    });
    const bytes = new Uint8Array(16);
    bytes.set(
      Array.from('{"hello":"x"}').map((c) => c.charCodeAt(0)),
      0,
    );
    await storage.putObject(upload.storageKey, bytes, "application/json");
    const out = await completeUpload(deps, {
      uploadId: upload.id,
      userId: USER,
    });
    expect(out.status).toBe("ready");
    expect(out.mime).toBe("application/json");
  });
});
