import type {
  LoginState,
  OAuthLoginState,
} from "../domain/oauth-login-state.js";

/**
 * Short-lived store for pending OAuth login attempts. Mirrors the shape
 * of `LinkAttemptStore` (account linking) but for the primary sign-in
 * flow.
 *
 * `consume` MUST be atomic w.r.t. the `used_at` flag: a concurrent
 * second call with the same state must return null (single-use token).
 * Postgres adapter uses `UPDATE ... WHERE used_at IS NULL RETURNING`
 * to satisfy this; in-memory adapter uses a guard on the boolean field.
 */
export interface OAuthLoginStateStore {
  put(attempt: OAuthLoginState): Promise<void>;
  /**
   * Atomically mark the row used and return its prior contents. Returns
   * null if no row matches OR if the row was already consumed.
   */
  consume(state: LoginState): Promise<OAuthLoginState | null>;
}
