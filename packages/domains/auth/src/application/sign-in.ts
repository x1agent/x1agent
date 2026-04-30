import type { AuthProvider } from "../ports/auth-provider.js";
import type { UserRepository } from "../ports/user-repository.js";
import type { SessionTokenizer } from "../ports/session-tokenizer.js";
import type { PersonRepository } from "../ports/person-repository.js";
import type { AccessGate } from "../ports/access-gate.js";
import {
  assertAllowedDomain,
  type AuthProfile,
} from "../domain/auth-profile.js";
import {
  assertHasMembership,
  type AuthSession,
} from "../domain/auth-session.js";
import { DomainNotAllowedError } from "../domain/errors.js";
import { isPlatformAdmin } from "../domain/platform-admin.js";

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
): Promise<SignInResult> {
  const rawProfile = await deps.authProvider.exchangeCode(code, redirectUri);
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
