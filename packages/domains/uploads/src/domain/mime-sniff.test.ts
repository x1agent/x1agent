import { describe, it, expect } from "bun:test";
import { extensionFor, sniffImageMime } from "./mime-sniff.js";

function buf(bytes: number[], pad = 32): Uint8Array {
  const out = new Uint8Array(Math.max(pad, bytes.length));
  out.set(bytes, 0);
  return out;
}

describe("sniffImageMime", () => {
  it("detects PNG", () => {
    expect(sniffImageMime(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
  });

  it("detects JPEG", () => {
    expect(sniffImageMime(buf([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("detects GIF87a and GIF89a", () => {
    const gif87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
    const gif89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
    expect(sniffImageMime(buf(gif87))).toBe("image/gif");
    expect(sniffImageMime(buf(gif89))).toBe("image/gif");
  });

  it("detects WebP", () => {
    const head = [
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // (size, ignored by sniff)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ];
    expect(sniffImageMime(buf(head))).toBe("image/webp");
  });

  it("returns null for non-image content", () => {
    expect(sniffImageMime(buf([0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(sniffImageMime(buf([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
  });

  it("returns null for too-short buffers", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe("extensionFor", () => {
  it("returns canonical extensions", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/gif")).toBe("gif");
    expect(extensionFor("image/webp")).toBe("webp");
  });

  it("returns null for unsupported MIMEs", () => {
    expect(extensionFor("application/pdf")).toBeNull();
    expect(extensionFor("image/bmp")).toBeNull();
  });
});
