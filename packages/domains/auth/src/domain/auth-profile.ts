import { Email } from "@x1agent/kernel";
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
