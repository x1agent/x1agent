import type { SessionTokenizer } from "../ports/session-tokenizer.js";
import type { AuthSession } from "../domain/auth-session.js";
import { SessionVerificationError } from "../domain/errors.js";

export function verifySessionToken(
  tokenizer: SessionTokenizer,
  token: string,
): AuthSession {
  const s = tokenizer.verify(token);
  if (!s) throw new SessionVerificationError();
  return s;
}
