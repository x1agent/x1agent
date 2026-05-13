import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import { UploadId, buildStorageKey, sanitizeFilename } from "./upload.js";

describe("UploadId", () => {
  it("accepts a v4 UUID", () => {
    const id = "9ac4f1d1-3b9c-4f1a-9e6b-1234567890ab";
    expect(UploadId(id)).toBe(id as unknown as string);
  });

  it("lowercases mixed case UUIDs", () => {
    const id = "9AC4F1D1-3B9C-4F1A-9E6B-1234567890AB";
    expect(UploadId(id)).toBe(id.toLowerCase() as unknown as string);
  });

  it("rejects non-UUID values (path traversal guard)", () => {
    expect(() => UploadId("../etc/passwd")).toThrow(ValidationError);
    expect(() => UploadId("not-a-uuid")).toThrow(ValidationError);
    expect(() => UploadId("")).toThrow(ValidationError);
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators", () => {
    expect(sanitizeFilename("../../etc/passwd", "png")).toBe("....etcpasswd");
  });

  it("strips control + null bytes", () => {
    const raw = `a${String.fromCharCode(0)}b${String.fromCharCode(0x1f)}c`;
    expect(sanitizeFilename(raw, "png")).toBe("abc");
  });

  it("caps at 255 chars", () => {
    const raw = "a".repeat(300) + ".png";
    expect(sanitizeFilename(raw, "png").length).toBe(255);
  });

  it("falls back when empty after sanitization", () => {
    expect(sanitizeFilename("///", "jpg")).toBe("upload.jpg");
    expect(sanitizeFilename("", "png")).toBe("upload.png");
  });
});

describe("buildStorageKey", () => {
  it("uses UTC date + the supplied id + ext", () => {
    const id = UploadId("9ac4f1d1-3b9c-4f1a-9e6b-1234567890ab");
    const at = new Date("2026-05-13T04:00:00Z");
    expect(buildStorageKey(id, "png", at)).toBe(
      "uploads/2026/05/13/9ac4f1d1-3b9c-4f1a-9e6b-1234567890ab.png",
    );
  });

  it("zero-pads single-digit months and days", () => {
    const id = UploadId("9ac4f1d1-3b9c-4f1a-9e6b-1234567890ab");
    const at = new Date("2026-01-05T00:00:00Z");
    expect(buildStorageKey(id, "webp", at)).toMatch(
      /^uploads\/2026\/01\/05\//,
    );
  });
});
