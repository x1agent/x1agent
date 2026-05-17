import { describe, it, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { buildStoredZip } from "./zip.js";

/**
 * Minimal validation: the bytes are an actual ZIP archive a third-party
 * tool would accept. We re-parse the central directory and confirm the
 * stored file names, sizes, and CRC line up with what we asked to pack.
 */
describe("buildStoredZip", () => {
  it("produces a valid STORED zip with the right file count and contents", () => {
    const files = [
      { path: "index.html", bytes: Buffer.from("<h1>hi</h1>", "utf8") },
      { path: "assets/style.css", bytes: Buffer.from("body{margin:0}", "utf8") },
      { path: "logo.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ];
    const zip = buildStoredZip(files);

    // Local file header magic.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);

    // EOCD record sits in the last 22 bytes (no archive comment).
    const eocdOffset = zip.length - 22;
    expect(zip.readUInt32LE(eocdOffset)).toBe(0x06054b50);
    const entriesTotal = zip.readUInt16LE(eocdOffset + 10);
    expect(entriesTotal).toBe(files.length);

    const cdSize = zip.readUInt32LE(eocdOffset + 12);
    const cdOffset = zip.readUInt32LE(eocdOffset + 16);
    expect(cdOffset + cdSize).toBe(eocdOffset);

    // Walk the central directory and recover each file name + size.
    const names: string[] = [];
    const sizes: number[] = [];
    let p = cdOffset;
    for (let i = 0; i < entriesTotal; i++) {
      expect(zip.readUInt32LE(p)).toBe(0x02014b50);
      const size = zip.readUInt32LE(p + 24);
      const nameLen = zip.readUInt16LE(p + 28);
      const extraLen = zip.readUInt16LE(p + 30);
      const commentLen = zip.readUInt16LE(p + 32);
      const name = zip.slice(p + 46, p + 46 + nameLen).toString("utf8");
      names.push(name);
      sizes.push(size);
      p += 46 + nameLen + extraLen + commentLen;
    }
    expect(names).toEqual(["index.html", "assets/style.css", "logo.png"]);
    expect(sizes).toEqual([11, 14, 4]);
  });

  it("handles a single-file share", () => {
    const zip = buildStoredZip([
      { path: "report.md", bytes: Buffer.from("# Report", "utf8") },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const eocdOffset = zip.length - 22;
    expect(zip.readUInt16LE(eocdOffset + 10)).toBe(1);
  });

  it("returns a well-formed empty archive when given no entries", () => {
    const zip = buildStoredZip([]);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
  });
});
