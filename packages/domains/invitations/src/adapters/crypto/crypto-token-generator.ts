import { randomBytes } from "node:crypto";
import type { TokenGenerator } from "../../ports/token-generator.js";
import { InvitationToken } from "../../domain/invitation.js";

/**
 * Mints 256-bit tokens using Node's CSPRNG, hex-encoded for URL safety.
 * Collision probability at any realistic volume is negligible; the repo
 * still enforces uniqueness at the DB level.
 */
export class CryptoTokenGenerator implements TokenGenerator {
  mint(): InvitationToken {
    return InvitationToken(randomBytes(32).toString("hex"));
  }
}
