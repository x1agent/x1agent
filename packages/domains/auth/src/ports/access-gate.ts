import type { Email } from "@x1agent/kernel";

/**
 * "Has this email been pre-authorized to sign in?"
 *
 * The domain-allowlist (ALLOWED_DOMAINS) is the broad gate — sign-in
 * is auto-allowed for anyone whose email lives on a trusted domain.
 *
 * For everyone else, we still allow sign-in IF they're already known
 * to the system: an existing user (presumably the result of a prior
 * accepted invitation) OR a still-pending invitation. This lets an
 * admin invite a Gmail user into a corporate-domain workspace
 * without weakening the domain whitelist for everyone else.
 *
 * Adapters live in the composition root and implement this against
 * Postgres. The fake in tests just returns a static map.
 */
export interface AccessGate {
  isPreAuthorized(email: Email): Promise<boolean>;
}

/** Always-deny gate. Use when no per-email allowlist is configured. */
export const denyAllAccessGate: AccessGate = {
  async isPreAuthorized() {
    return false;
  },
};
