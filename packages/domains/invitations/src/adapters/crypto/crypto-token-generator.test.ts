import { describe, it, expect } from "bun:test";
import { CryptoTokenGenerator } from "./crypto-token-generator.js";

describe("CryptoTokenGenerator", () => {
  it("produces 64-hex-char tokens", () => {
    const t = new CryptoTokenGenerator().mint();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces distinct tokens on successive calls", () => {
    const g = new CryptoTokenGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(g.mint());
    expect(seen.size).toBe(100);
  });
});
