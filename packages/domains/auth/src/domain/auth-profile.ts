import { Email } from "@x1agent/kernel";
import type { OAuthGrant } from "./oauth-grant.js";
import { DomainNotAllowedError } from "./errors.js";

/**
 * Normalized identity returned by any AuthProvider adapter after
 * exchanging an authorization code. Fields map to what every OAuth/OIDC
 * provider can produce; provider-specific quirks stay inside the adapter.
 */
export interface AuthProfile {
  email: Email;
  name: string;
  avatarUrl: string | null;
  /** Stable, provider-scoped user identifier (e.g. Google `sub`). */
  providerUserId: string;
  /** Which AuthProvider produced this profile. */
  providerId: string;
  /**
   * OAuth grant (access_token / refresh_token / scopes / expiry) when
   * the provider returned downstream-API tokens. Present for Google
   * sign-ins and any future provider that issues tokens we'll use to
   * call the provider's APIs on the user's behalf. Absent for
   * dev-bypass and password-auth flows. Sign-in core ignores this
   * field for identity decisions; it's persisted via the optional
   * UserOAuthTokenStore dependency in completeSignIn.
   */
  oauthGrant?: OAuthGrant;
}

/**
 * Enforce the domain-allowlist invariant. Returns the profile unchanged
 * when allowed, throws otherwise. No I/O.
 */
export function assertAllowedDomain(
  profile: AuthProfile,
  allowed: readonly string[],
): AuthProfile {
  if (allowed.length === 0) return profile;
  const domain = profile.email.split("@")[1]!;
  if (!allowed.includes(domain)) {
    throw new DomainNotAllowedError(domain, allowed);
  }
  return profile;
}
