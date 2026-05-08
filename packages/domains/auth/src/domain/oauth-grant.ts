/**
 * OAuth grant returned by an AuthProvider after exchanging an
 * authorization code. Carries the tokens we need to act on the
 * user's behalf with the provider's downstream APIs (Drive, Calendar,
 * Gmail, … for Google; the equivalents for any future provider).
 *
 * AuthProfile carries identity (email, name, sub). OAuthGrant carries
 * authorization (the keys to act). Two value objects, two
 * responsibilities — keeps profile lean for callers (sign-in core,
 * domain allowlist check, access gate) that don't need tokens.
 *
 * Optional on AuthProfile: providers that don't issue downstream-API
 * tokens (dev-bypass, password auth, OIDC-only configurations) just
 * omit this. Caller checks for presence before persisting.
 */
export interface OAuthGrant {
  /** Stable, never-throws-on-rotation identifier matching AuthProvider.id. */
  providerId: string;
  /** Raw access token. Plaintext only inside this value object. */
  accessToken: string;
  /**
   * Refresh token if the provider issued one. Many providers omit it
   * on subsequent grants (Google requires `prompt=consent` to re-issue);
   * absence means "next exchange must re-prompt the user."
   */
  refreshToken: string | null;
  /**
   * Scopes the user actually granted. May be a subset of the requested
   * scopes if the user unchecked some at the consent screen. Stored
   * as-is; downstream callers compare requested-scope membership.
   */
  scopesGranted: readonly string[];
  /**
   * UTC instant when the access token expires. Null when the provider
   * doesn't supply expiry; callers treat null as "always refresh."
   */
  expiresAt: Date | null;
}

/** Encrypted-on-disk projection of a single OAuth token field. */
export interface EncryptedToken {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
}

/**
 * Persistable shape — what the postgres adapter writes. Plaintext
 * tokens become EncryptedToken values via the cipher boundary; the
 * adapter never sees plaintext, the application service never sees
 * ciphertext.
 */
export interface UserOAuthTokenRow {
  id: string;
  userId: string;
  providerId: string;
  scopesGranted: readonly string[];
  expiresAt: Date | null;
  hasRefreshToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Returns true if every requested scope is present in the granted set.
 * Caller checks this before issuing an access token — refusing here
 * keeps downstream provider calls from emitting a confusing 403 from
 * the upstream API instead of a clean "permission_required."
 */
export function hasGrantedScopes(
  granted: readonly string[],
  requested: readonly string[],
): boolean {
  if (requested.length === 0) return true;
  const grantedSet = new Set(granted);
  return requested.every((scope) => grantedSet.has(scope));
}
