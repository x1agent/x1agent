import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock } from "@x1agent/kernel";
import { runUploadStorageContract } from "../../contract-tests/upload-storage.contract.js";
import { LocalDiskStorage } from "./local-disk-storage.js";

const tmpRoots: string[] = [];

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "x1a-uploads-"));
  tmpRoots.push(d);
  return d;
}

runUploadStorageContract({
  name: "LocalDiskStorage",
  factory: async () => {
    const rootDir = await freshDir();
    return new LocalDiskStorage({
      rootDir,
      publicBaseUrl: "http://api.test/api/uploads",
      hmacSecret: "test-secret",
      clock: new FixedClock(new Date("2026-05-13T04:00:00Z")),
    });
  },
  cleanup: async () => {
    while (tmpRoots.length) {
      const d = tmpRoots.pop()!;
      await rm(d, { recursive: true, force: true });
    }
  },
});

describe("LocalDiskStorage — path traversal guardrails", () => {
  it("refuses keys outside the uploads/ prefix", async () => {
    const rootDir = await freshDir();
    const s = new LocalDiskStorage({
      rootDir,
      publicBaseUrl: "http://api.test/api/uploads",
      hmacSecret: "test-secret",
      clock: new FixedClock(new Date()),
    });
    await expect(
      s.putObject("../escape.png", new Uint8Array([1]), "image/png"),
    ).rejects.toThrow(/outside uploads/);
    await expect(
      s.putObject("uploads/../escape.png", new Uint8Array([1]), "image/png"),
    ).rejects.toThrow(/traversal/);
  });

  it("verifyUploadToken accepts a valid signature + rejects tampering", async () => {
    const rootDir = await freshDir();
    const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
    const s = new LocalDiskStorage({
      rootDir,
      publicBaseUrl: "http://api.test/api/uploads",
      hmacSecret: "test-secret",
      clock,
    });
    const key = "uploads/2026/05/13/11111111-1111-7111-8111-111111111111.png";
    const out = await s.createUploadUrl({
      key,
      contentType: "image/png",
      contentLength: 8,
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    const url = new URL(out.url);
    const exp = Number(url.searchParams.get("exp"));
    const len = Number(url.searchParams.get("len"));
    const ct = url.searchParams.get("ct")!;
    const sig = url.searchParams.get("sig")!;

    // valid
    expect(() =>
      s.verifyUploadToken({ key, expSec: exp, len, contentType: ct, sig }),
    ).not.toThrow();

    // wrong length
    expect(() =>
      s.verifyUploadToken({
        key,
        expSec: exp,
        len: len + 1,
        contentType: ct,
        sig,
      }),
    ).toThrow(/invalid_signature/);

    // expired
    clock.advance(120_000);
    expect(() =>
      s.verifyUploadToken({ key, expSec: exp, len, contentType: ct, sig }),
    ).toThrow(/expired/);
  });
});
