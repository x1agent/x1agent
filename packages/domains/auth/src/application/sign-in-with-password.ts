import type { UserRepository } from "../ports/user-repository.js";
import type { SessionTokenizer } from "../ports/session-tokenizer.js";
import type { PasswordCredentialStore } from "../ports/password-credential-store.js";
import type { PersonRepository } from "../ports/person-repository.js";
import type { Email, UserId } from "@x1agent/kernel";
import { assertHasMembership } from "../domain/auth-session.js";
import { isPlatformAdmin } from "../domain/platform-admin.js";
import { PasswordSignInFailedError } from "../domain/errors.js";
import type { SignInResult } from "./sign-in.js";

export interface SignInWithPasswordDeps {
  passwords: PasswordCredentialStore;
  users: UserRepository;
  tokenizer: SessionTokenizer;
  /**
   * Optional — same as the OAuth sign-in path: when provided we
   * ensure every user has a person_id. Quickstart-seeded users
   * already have one, but keeping this symmetrical with signInWithCode
   * means callers don't have to reason about two different
   * invariants.
   */
  persons?: PersonRepository;
  platformAdmins: readonly string[];
}

/**
 * Email + password sign-in. Separate from the OAuth path because they
 * share almost nothing in the middle: no provider exchange, no
 * upsert-from-profile, no domain allowlist (local accounts are
 * explicitly exempt — the allowlist exists to constrain SSO sprawl,
 * not to lock out admin-seeded users).
 *
 * Every failure mode collapses to PasswordSignInFailedError so the
 * HTTP layer can't accidentally leak account existence.
 */
export async function signInWithPassword(
  deps: SignInWithPasswordDeps,
  email: Email,
  password: string,
): Promise<SignInResult> {
  const ok = await deps.passwords.verify(email, password);
  if (!ok) throw new PasswordSignInFailedError();

  const user = await deps.users.findById(ok.userId as UserId);
  if (!user) throw new PasswordSignInFailedError();

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
