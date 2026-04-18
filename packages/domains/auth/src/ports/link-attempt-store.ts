import type { LinkAttempt, LinkState } from "../domain/link-attempt.js";

/**
 * Short-lived key/value store for pending account-link attempts.
 * Implementations MAY back this with Postgres (one row, periodic sweep)
 * or an in-memory TTL map. The domain only requires consistent read
 * after write within the lifetime of a single attempt.
 */
export interface LinkAttemptStore {
  put(attempt: LinkAttempt): Promise<void>;
  /** Return and DELETE the attempt in one atomic read (single-use token). */
  consume(state: LinkState): Promise<LinkAttempt | null>;
}
