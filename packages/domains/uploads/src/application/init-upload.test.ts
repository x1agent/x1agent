import { describe, it, expect } from "bun:test";
import { FixedClock, UserId } from "@x1agent/kernel";
import { DEFAULT_UPLOADS_CONFIG } from "../domain/config.js";
import { UploadId } from "../domain/upload.js";
import {
  UploadMimeNotAllowedError,
  UploadTooLargeError,
} from "../domain/errors.js";
import { InMemoryUploadStorage } from "../adapters/in-memory-storage.js";
import { initUpload } from "./init-upload.js";
import { InMemoryUploadRepository } from "./fakes.js";

const USER = UserId("9ac4f1d1-3b9c-4f1a-9e6b-1234567890ab");
const ID = "11111111-1111-7111-8111-111111111111";

function deps() {
  const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
  const uploads = new InMemoryUploadRepository();
  const storage = new InMemoryUploadStorage();
  return {
    uploads,
    storage,
    clock,
    config: DEFAULT_UPLOADS_CONFIG,
    uuid: () => UploadId(ID),
  };
}

describe("initUpload", () => {
  it("inserts a pending row + returns an upload URL", async () => {
    const d = deps();
    const r = await initUpload(d, {
      userId: USER,
      filename: "hello.png",
      mimeHint: "image/png",
      sizeBytes: 1024,
      sessionId: null,
    });
    expect(r.upload.id).toBe(UploadId(ID));
    expect(r.upload.status).toBe("pending");
    expect(r.upload.storageKey).toBe(
      `uploads/2026/05/13/${ID}.png`,
    );
    expect(r.upload.expiresAt.getTime() - d.clock.now().getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(r.uploadUrl.method).toBe("PUT");
  });

  it("rejects oversized files at the gate", async () => {
    const d = deps();
    await expect(
      initUpload(d, {
        userId: USER,
        filename: "huge.png",
        mimeHint: "image/png",
        sizeBytes: DEFAULT_UPLOADS_CONFIG.maxBytes + 1,
        sessionId: null,
      }),
    ).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  it("rejects disallowed MIMEs", async () => {
    const d = deps();
    await expect(
      initUpload(d, {
        userId: USER,
        filename: "archive.zip",
        mimeHint: "application/zip",
        sizeBytes: 100,
        sessionId: null,
      }),
    ).rejects.toBeInstanceOf(UploadMimeNotAllowedError);
  });

  it("accepts text/html (added so previous-session HTML artifacts can be re-attached)", async () => {
    const d = deps();
    const r = await initUpload(d, {
      userId: USER,
      filename: "report.html",
      mimeHint: "text/html",
      sizeBytes: 100,
      sessionId: null,
    });
    expect(r.upload.mime).toBe("text/html");
  });

  it("sanitizes the filename", async () => {
    const d = deps();
    const r = await initUpload(d, {
      userId: USER,
      filename: "../../etc/passwd",
      mimeHint: "image/png",
      sizeBytes: 100,
      sessionId: null,
    });
    expect(r.upload.filename).not.toContain("/");
  });
});
