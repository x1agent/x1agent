import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import {
  writeShareFiles,
  readShareFile,
  sharesDir,
} from "./storage";

describe("storage: flat shares/{share_id}/{path} layout", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(`${osTmpdir()}/x1-share-test-`);
    process.env.X1_SHARES_DIR = dir;
  });

  afterEach(() => {
    delete process.env.X1_SHARES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes files under shares/{share_id}/ with no session_id segment", async () => {
    const total = await writeShareFiles(
      "abc-123",
      [
        { path: "index.html", content: Buffer.from("hi").toString("base64") },
        { path: "assets/x.css", content: Buffer.from("y").toString("base64") },
      ],
    );
    expect(total).toBe(3);
    expect(existsSync(resolve(dir, "shares", "abc-123", "index.html"))).toBe(true);
    expect(existsSync(resolve(dir, "shares", "abc-123", "assets", "x.css"))).toBe(true);
    // Explicitly assert the old session-keyed prefix is NOT used.
    expect(existsSync(resolve(dir, "sessions"))).toBe(false);
  });

  it("readShareFile finds the bytes by share_id alone", async () => {
    await writeShareFiles(
      "abc-123",
      [{ path: "index.html", content: Buffer.from("payload").toString("base64") }],
    );
    const bytes = readShareFile("abc-123", "index.html");
    expect(bytes?.toString()).toBe("payload");
  });

  it("readShareFile returns null when the file doesn't exist", () => {
    const bytes = readShareFile("missing-share", "anything.html");
    expect(bytes).toBeNull();
  });

  it("readShareFile refuses path traversal", async () => {
    await writeShareFiles(
      "abc-123",
      [{ path: "index.html", content: Buffer.from("x").toString("base64") }],
    );
    expect(readShareFile("abc-123", "../../etc/passwd")).toBeNull();
  });

  it("sharesDir honours X1_SHARES_DIR", () => {
    expect(sharesDir()).toBe(dir);
  });
});
