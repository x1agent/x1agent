import { DomainError } from "@x1agent/kernel";

declare const loginStateBrand: unique symbol;
export type LoginState = string & { readonly [loginStateBrand]: true };
export const LoginState = (raw: string): LoginState => raw as LoginState;

/**
 * Short-lived record created when the browser hits `/auth/google` to
 * begin sign-in. The `state` token round-trips through Google OAuth and
 * is verified on the callback (OAuth 2.0 §10.12 — login CSRF defense).
 *
 * `codeVerifier` is the PKCE secret (RFC 7636); the matching
 * `code_challenge` was sent on the authorize URL and the verifier is
 * sent on the token exchange.
 *
 * `redirectPath` is an optional server-side post-auth destination so we
 * never have to trust a client-controlled `?next=` parameter on the
 * callback (open-redirect defense).
 *
 * `usedAt` enforces single-use: replays are rejected at the store layer.
 */
export interface OAuthLoginState {
  state: LoginState;
  codeVerifier: string;
  redirectPath: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export class OAuthLoginStateInvalidError extends DomainError {
  readonly code = "oauth_state_invalid";
  constructor(message = "the OAuth state token is missing, expired, mismatched, or already used") {
    super(message);
  }
}

export function assertLoginStateFresh(
  attempt: OAuthLoginState,
  now: Date,
): void {
  if (attempt.usedAt) throw new OAuthLoginStateInvalidError("state already used");
  if (attempt.expiresAt.getTime() < now.getTime())
    throw new OAuthLoginStateInvalidError("state expired");
}
