import { describe, it, expect } from "bun:test";
import { encrypt, decrypt, loadMasterKey } from "./cipher.js";

const TEST_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_KEY = loadMasterKey(TEST_KEY_HEX);

describe("loadMasterKey", () => {
  it("loads a 64-char hex key into 32 bytes", () => {
    expect(TEST_KEY.byteLength).toBe(32);
  });

  it("rejects empty / undefined", () => {
    expect(() => loadMasterKey("")).toThrow();
    expect(() => loadMasterKey(undefined)).toThrow();
    expect(() => loadMasterKey("   ")).toThrow();
  });

  it("rejects non-hex", () => {
    expect(() => loadMasterKey("not-hex-at-all")).toThrow();
    expect(() => loadMasterKey("zz".repeat(32))).toThrow();
  });

  it("rejects wrong length", () => {
    expect(() => loadMasterKey("ab".repeat(16))).toThrow(); // 32 chars = 16 bytes
    expect(() => loadMasterKey("ab".repeat(48))).toThrow(); // 96 chars = 48 bytes
  });
});

describe("encrypt / decrypt round-trip", () => {
  it.each([
    "simple value",
    "example token value",
    "value with newlines\nand\ttabs",
    "unicode: 日本語 émojis 🔐",
    "x".repeat(10_000), // realistic upper bound for an API token
    " ", // single space
  ])("round-trips %p", (plaintext) => {
    const blob = encrypt(plaintext, TEST_KEY);
    expect(decrypt(blob, TEST_KEY)).toBe(plaintext);
  });

  it("produces unique ciphertexts for the same plaintext (random nonce)", () => {
    const a = encrypt("same value", TEST_KEY);
    const b = encrypt("same value", TEST_KEY);
    // Different nonces → different ciphertexts.
    expect(Buffer.from(a.nonce).toString("hex")).not.toBe(
      Buffer.from(b.nonce).toString("hex"),
    );
    expect(Buffer.from(a.ciphertext).toString("hex")).not.toBe(
      Buffer.from(b.ciphertext).toString("hex"),
    );
    // Both still decrypt correctly.
    expect(decrypt(a, TEST_KEY)).toBe("same value");
    expect(decrypt(b, TEST_KEY)).toBe("same value");
  });

  it("nonce is exactly 12 bytes (NIST SP 800-38D)", () => {
    const blob = encrypt("anything", TEST_KEY);
    expect(blob.nonce.byteLength).toBe(12);
  });

  it("auth tag is exactly 16 bytes (AES-GCM default)", () => {
    const blob = encrypt("anything", TEST_KEY);
    expect(blob.authTag.byteLength).toBe(16);
  });
});

describe("decrypt failure modes", () => {
  it("rejects tampered ciphertext (auth tag mismatch)", () => {
    const blob = encrypt("legit value", TEST_KEY);
    const tampered = {
      ...blob,
      ciphertext: new Uint8Array(blob.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it("rejects tampered auth tag", () => {
    const blob = encrypt("legit value", TEST_KEY);
    const tampered = { ...blob, authTag: new Uint8Array(blob.authTag) };
    tampered.authTag[0] ^= 0xff;
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it("rejects wrong nonce length", () => {
    const blob = encrypt("legit", TEST_KEY);
    expect(() =>
      decrypt({ ...blob, nonce: new Uint8Array(11) }, TEST_KEY),
    ).toThrow();
  });

  it("rejects wrong key", () => {
    const blob = encrypt("legit", TEST_KEY);
    const otherKey = loadMasterKey("ff".repeat(32));
    expect(() => decrypt(blob, otherKey)).toThrow();
  });
});
