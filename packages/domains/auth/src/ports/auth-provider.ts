import type { AuthProfile } from "../domain/auth-profile.js";

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
   * authentication. `state` round-trips back via the callback.
   */
  getAuthorizeUrl(redirectUri: string, state?: string): string;

  /**
   * Exchange an authorization code (as received on the callback) for a
   * normalized profile. Implementations MUST validate provider signatures,
   * token audience, and expiry before returning.
   */
  exchangeCode(code: string, redirectUri: string): Promise<AuthProfile>;
}
