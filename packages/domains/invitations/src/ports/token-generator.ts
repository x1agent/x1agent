import type { InvitationToken } from "../domain/invitation.js";

/**
 * Mint a single-use invitation token. Implementations MUST use a CSPRNG
 * and return a URL-safe string of at least 256 bits of entropy.
 */
export interface TokenGenerator {
  mint(): InvitationToken;
}
