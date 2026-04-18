import jwt from "jsonwebtoken";
import type { SessionTokenizer } from "../../ports/session-tokenizer.js";
import type { AuthSession } from "../../domain/auth-session.js";

export interface JwtSessionTokenizerConfig {
  secret: string;
  expiresIn?: jwt.SignOptions["expiresIn"];
}

/**
 * HS256-signed JWT carrying a serialized AuthSession. The kernel's
 * branded types are erased in transit and re-asserted on the way out,
 * so callers still get a well-typed AuthSession from `verify()`.
 */
export class JwtSessionTokenizer implements SessionTokenizer {
  constructor(private readonly config: JwtSessionTokenizerConfig) {}

  sign(session: AuthSession): string {
    return jwt.sign({ session }, this.config.secret, {
      expiresIn: this.config.expiresIn ?? "24h",
    });
  }

  verify(token: string): AuthSession | null {
    try {
      const decoded = jwt.verify(token, this.config.secret) as {
        session: AuthSession;
      };
      return decoded.session;
    } catch {
      return null;
    }
  }
}
