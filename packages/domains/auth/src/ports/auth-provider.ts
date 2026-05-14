import type { AuthProfile } from "../domain/auth-profile.js";

/**
 * Optional PKCE parameters (RFC 7636). When supplied on the
 * authorize URL, the matching `codeVerifier` MUST be supplied on the
 * subsequent code exchange or the provider will reject the call.
 *
 * Adapters that don't speak OAuth 2.0 / OIDC may ignore PKCE inputs
 * silently — the contract only requires the happy path round-trip.
 */
export interface AuthorizeUrlOptions {
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
}

export interface ExchangeCodeOptions {
  codeVerifier?: string;
}

/**
 * AuthProvider is the swappable piece of the `auth` provider domain.
 * Docs: /providers/overview, /security/credential-proxy.
 *
 * Implementations (adapters):
 *   - google   — Google OAuth 2.0 / OIDC
 *   - dev-bypass — local-only, trusts the API to assert the test user
 *   - (future) github, okta, saml, …
 *
 * The contract-test suite at ./contract-tests/auth-provider.contract.ts
 * is authoritative: every adapter must pass it before being wired up.
 */
export interface AuthProvider {
  /** Stable identifier, e.g. "google", "dev-bypass". */
  readonly id: string;

  /**
   * Build the URL the browser should be redirected to in order to start
   * authentication. `state` round-trips back via the callback. PKCE
   * `codeChallenge` is optional but strongly recommended for OAuth 2.0
   * adapters.
   */
  getAuthorizeUrl(
    redirectUri: string,
    state?: string,
    options?: AuthorizeUrlOptions,
  ): string;

  /**
   * Exchange an authorization code (as received on the callback) for a
   * normalized profile. Implementations MUST validate provider signatures,
   * token audience, and expiry before returning. When PKCE was used on
   * the authorize URL the matching `codeVerifier` MUST be threaded
   * through.
   */
  exchangeCode(
    code: string,
    redirectUri: string,
    options?: ExchangeCodeOptions,
  ): Promise<AuthProfile>;
}
