import type { AuthProvider } from "../ports/auth-provider.js";
import type { UserRepository } from "../ports/user-repository.js";
import type { SessionTokenizer } from "../ports/session-tokenizer.js";
import type { PersonRepository } from "../ports/person-repository.js";
import type { AccessGate } from "../ports/access-gate.js";
import type { UserOAuthTokenStore } from "../ports/user-oauth-token-store.js";
import {
  assertAllowedDomain,
  type AuthProfile,
} from "../domain/auth-profile.js";
import {
  assertHasMembership,
  type AuthSession,
} from "../domain/auth-session.js";
import type { EncryptedToken, OAuthGrant } from "../domain/oauth-grant.js";
import { DomainNotAllowedError } from "../domain/errors.js";
import { isPlatformAdmin } from "../domain/platform-admin.js";

/**
 * Encrypts a plaintext token at the cipher boundary. Composition root
 * supplies an implementation backed by AES-256-GCM and the
 * deployment-wide WORKSPACE_SECRETS_MASTER_KEY (same cipher used by
 * workspace_secrets / mcp_oauth_clients / user_mcp_tokens). Domain
 * doesn't import the cipher directly — keeps the auth domain
 * crypto-agnostic and the cipher swappable for tests.
 */
export type EncryptOAuthToken = (plaintext: string) => EncryptedToken;

export interface SignInDeps {
  authProvider: AuthProvider;
  users: UserRepository;
  tokenizer: SessionTokenizer;
  /**
   * Optional: when provided, sign-in ensures the user has a person_id.
   * First-time users get a fresh Person; returning users keep theirs.
   */
  persons?: PersonRepository;
  allowedDomains: readonly string[];
  platformAdmins: readonly string[];
  /**
   * Optional per-email allowlist. When set, an email that fails the
   * domain-allowlist still gets in if isPreAuthorized() returns true
   * (existing user or pending invitation). Lets admins invite users
   * outside the domain whitelist without weakening it for everyone.
   */
  accessGate?: AccessGate;
  /**
   * Optional user-OAuth-token persistence. When the auth provider
   * returned an OAuthGrant on the profile AND this dep is wired, the
   * grant is encrypted and upserted. Keeps the token-store concern
   * cleanly outside the identity path — installs that don't have
   * downstream-API providers wired (no Google Workspace integration
   * yet) skip this entirely.
   */
  oauthTokens?: {
    store: UserOAuthTokenStore;
    encrypt: EncryptOAuthToken;
  };
}

export interface SignInResult {
  session: AuthSession;
  token: string;
}

/**
 * End-to-end sign-in: exchange code, enforce allowlist, upsert user,
 * compose session, mint token. Pure orchestration — every side effect
 * goes through a port.
 */
export async function signInWithCode(
  deps: SignInDeps,
  code: string,
  redirectUri: string,
  options?: { codeVerifier?: string },
): Promise<SignInResult> {
  const rawProfile = await deps.authProvider.exchangeCode(
    code,
    redirectUri,
    options?.codeVerifier ? { codeVerifier: options.codeVerifier } : undefined,
  );
  return completeSignIn(deps, rawProfile);
}

/**
 * Shared tail for any sign-in flow that already has a profile (dev-bypass,
 * magic links, impersonation). Kept separate from code-exchange so it can
 * be composed.
 */
export async function completeSignIn(
  deps: Omit<SignInDeps, "authProvider">,
  rawProfile: AuthProfile,
): Promise<SignInResult> {
  let profile: AuthProfile;
  try {
    profile = assertAllowedDomain(rawProfile, deps.allowedDomains);
  } catch (err) {
    if (err instanceof DomainNotAllowedError && deps.accessGate) {
      const allowed = await deps.accessGate.isPreAuthorized(rawProfile.email);
      if (!allowed) throw err;
      profile = rawProfile;
    } else {
      throw err;
    }
  }
  const user = await deps.users.upsertFromProfile(profile);

  if (deps.persons) {
    const existing = await deps.persons.findPersonIdForUser(user.id);
    if (!existing) {
      const person = await deps.persons.create({ displayName: user.name });
      await deps.persons.attachUser(user.id, person.id);
    }
  }

  // Persist the provider's OAuth grant when both the grant and the
  // token store are present. Best-effort: a failure here doesn't deny
  // the sign-in itself (the user already has identity), but it does
  // log so a subsequent provider call can surface
  // permission_required cleanly. Sign-in identity is NOT gated on
  // downstream-API access being available.
  if (profile.oauthGrant && deps.oauthTokens) {
    try {
      await persistOAuthGrant(deps.oauthTokens, user.id, profile.oauthGrant);
    } catch (err) {
      console.warn(
        `[auth] failed to persist OAuth grant for ${profile.providerId}: ${(err as Error).message}`,
      );
    }
  }

  const memberships = await deps.users.listMemberships(user.id);
  const session = assertHasMembership({
    userId: user.id,
    email: user.email,
    name: user.name,
    memberships,
    isPlatformAdmin: isPlatformAdmin(user.email, deps.platformAdmins),
  });
  const token = deps.tokenizer.sign(session);
  return { session, token };
}

async function persistOAuthGrant(
  oauthTokens: { store: UserOAuthTokenStore; encrypt: EncryptOAuthToken },
  userId: string,
  grant: OAuthGrant,
): Promise<void> {
  const encryptedAccess = oauthTokens.encrypt(grant.accessToken);
  const encryptedRefresh = grant.refreshToken
    ? oauthTokens.encrypt(grant.refreshToken)
    : null;
  await oauthTokens.store.upsert({
    userId,
    providerId: grant.providerId,
    accessToken: encryptedAccess,
    refreshToken: encryptedRefresh,
    scopesGranted: grant.scopesGranted,
    expiresAt: grant.expiresAt,
  });
}
