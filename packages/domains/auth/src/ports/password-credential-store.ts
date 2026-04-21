import type { Email } from "@x1agent/kernel";

/**
 * Password credentials live side-by-side with the OAuth identity on
 * the user row — a user can have a password AND a Google link, or
 * just one. This port is the only thing that reads/writes the hashed
 * secret; routes never see plaintext past the boundary.
 *
 * Implementations MUST:
 *   - Use an argon2id (or equivalent modern KDF) hash stored with its
 *     parameters so future rotation is possible.
 *   - Return `null` from `verify` both for missing-user and wrong-password
 *     cases; the caller translates to a single error code so a bad
 *     actor can't use differing responses to enumerate accounts.
 */
export interface PasswordCredentialStore {
  /**
   * Verify an email + plaintext pair. Returns the user's id on
   * success, `null` on every other outcome (no user, no password set
   * for the user, wrong password, verifier error). Constant-time
   * comparison is the adapter's responsibility.
   */
  verify(
    email: Email,
    plaintext: string,
  ): Promise<{ userId: string } | null>;

  /**
   * Install or replace a password for the user. Used by the quickstart
   * seeder and by future "change my password" flows. Passing null
   * removes the password — SSO becomes the only way in.
   */
  setPassword(
    userId: string,
    plaintext: string | null,
  ): Promise<void>;
}
