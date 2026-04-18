import type { AuthSession } from "../domain/auth-session.js";

/**
 * Turn an AuthSession into a bearer token the browser carries in a cookie,
 * and back. Implementations choose their own signing scheme; domain code
 * never sees the raw secret.
 */
export interface SessionTokenizer {
  sign(session: AuthSession): string;
  /** Returns null on any verification failure (expired, tampered, garbage). */
  verify(token: string): AuthSession | null;
}
