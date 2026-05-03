import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { EncryptedSecret } from "../domain/secret.js";

/**
 * AES-256-GCM authenticated encryption for workspace secrets.
 *
 * Key shape: 32 raw bytes. Loaded from env once per process via
 * loadMasterKey(). Throwing on missing/invalid keys is intentional —
 * we fail closed rather than ship an "unencrypted" path.
 *
 * Nonce: random 96 bits per encryption call (NIST SP 800-38D). At
 * 96 bits, the birthday bound is ~2^48 encryptions before collision
 * probability matters; this is well past the lifetime of any single
 * deployment under any plausible workload.
 *
 * Auth tag: 128 bits (the AES-GCM default).
 *
 * Format on disk: three columns (ciphertext, nonce, auth_tag). Could
 * have packed them into one BYTEA, but the columns make rotation
 * tooling easier to reason about and Postgres' on-disk overhead is
 * trivial.
 */

const ALG = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type MasterKey = Uint8Array & { readonly __brand: "MasterKey" };

/** Decode a hex-encoded master key from env. Throws if missing or wrong size. */
export function loadMasterKey(envValue: string | undefined): MasterKey {
  if (!envValue || envValue.trim() === "") {
    throw new Error(
      "WORKSPACE_SECRETS_MASTER_KEY is unset. Generate one with `openssl rand -hex 32` and add to install config.",
    );
  }
  const hex = envValue.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("WORKSPACE_SECRETS_MASTER_KEY must be hex-encoded");
  }
  if (hex.length !== KEY_BYTES * 2) {
    throw new Error(
      `WORKSPACE_SECRETS_MASTER_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars); got ${hex.length}`,
    );
  }
  return new Uint8Array(Buffer.from(hex, "hex")) as MasterKey;
}

/** Constant-time equality. Wrapper over timingSafeEqual that handles size mismatches gracefully. */
export function keysEqual(a: MasterKey, b: MasterKey): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

export function encrypt(plaintext: string, key: MasterKey): EncryptedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALG, Buffer.from(key), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  if (authTag.byteLength !== TAG_BYTES) {
    // Defense-in-depth — Node guarantees this, but the cipher state
    // is opaque enough that an explicit check is cheap insurance.
    throw new Error(
      `unexpected auth tag length: got ${authTag.byteLength}, want ${TAG_BYTES}`,
    );
  }
  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce: new Uint8Array(nonce),
    authTag: new Uint8Array(authTag),
  };
}

export function decrypt(blob: EncryptedSecret, key: MasterKey): string {
  if (blob.nonce.byteLength !== NONCE_BYTES) {
    throw new Error(
      `nonce must be ${NONCE_BYTES} bytes; got ${blob.nonce.byteLength}`,
    );
  }
  if (blob.authTag.byteLength !== TAG_BYTES) {
    throw new Error(
      `auth tag must be ${TAG_BYTES} bytes; got ${blob.authTag.byteLength}`,
    );
  }
  const decipher = createDecipheriv(ALG, Buffer.from(key), Buffer.from(blob.nonce));
  decipher.setAuthTag(Buffer.from(blob.authTag));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext)),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
