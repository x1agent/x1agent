import type postgres from "postgres";
import type { Email } from "@x1agent/kernel";
import type { PasswordCredentialStore } from "../../ports/password-credential-store.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  password_hash: string | null;
}

/**
 * Password adapter backed by Bun's built-in argon2id. We lean on
 * `Bun.password.verify` rather than re-importing a Node-native argon
 * crate because the api already requires Bun (it's the `dev` /
 * `start` runtime) and Bun's implementation is the reference one.
 *
 * The stored hash includes every parameter (variant, t, m, p, salt)
 * so rotating argon2 cost later doesn't need a migration — new hashes
 * get the new cost, old hashes still verify.
 */
export class PostgresPasswordCredentialStore
  implements PasswordCredentialStore
{
  constructor(private readonly sql: Sql) {}

  async verify(
    email: Email,
    plaintext: string,
  ): Promise<{ userId: string } | null> {
    const rows = await this.sql<Row[]>`
      SELECT id, password_hash FROM users WHERE email = ${email} LIMIT 1
    `;
    const row = rows[0];
    // Short-circuit both "no user" and "user without password" to a
    // null return. Callers translate to a single error code so these
    // two outcomes are indistinguishable from the outside. We still
    // burn a hash-verify when no row exists to keep the response
    // timing roughly uniform — a user-enumeration oracle via timing
    // is cheap to close here.
    if (!row || !row.password_hash) {
      await burnVerify(plaintext);
      return null;
    }
    const ok = await Bun.password.verify(plaintext, row.password_hash);
    if (!ok) return null;
    return { userId: row.id };
  }

  async setPassword(userId: string, plaintext: string | null): Promise<void> {
    if (plaintext === null) {
      await this.sql`
        UPDATE users
        SET password_hash = NULL, password_updated_at = NOW()
        WHERE id = ${userId}
      `;
      return;
    }
    const hash = await Bun.password.hash(plaintext, {
      algorithm: "argon2id",
      // Defaults are conservative enough for a local/dev tool. Crank
      // later if this runs on bigger iron.
      memoryCost: 19_456,
      timeCost: 2,
    });
    await this.sql`
      UPDATE users
      SET password_hash = ${hash}, password_updated_at = NOW()
      WHERE id = ${userId}
    `;
  }
}

/**
 * Verify against a throwaway hash so "no user found" and "user has no
 * password" take roughly as long as a real verify. Not a
 * constant-time guarantee — argon2's runtime is input-size dependent
 * and we're running on a shared event loop — but it closes the
 * obvious oracle.
 */
const SINK_HASH =
  // argon2id hash of a constant nonce; the plaintext being verified
  // against it will always fail, but the CPU cost is real.
  "$argon2id$v=19$m=19456,t=2,p=1$" +
  "cGFkZGluZ3NhbHRwYWRkaW5nc2E$" +
  "N7M6pR1vQ8zQmYzgz/4L9U1xVf3QoG0rPfhbeVeH/Ns";

async function burnVerify(plaintext: string): Promise<void> {
  try {
    await Bun.password.verify(plaintext, SINK_HASH);
  } catch {
    // ignore — the only thing we're buying here is CPU time.
  }
}
