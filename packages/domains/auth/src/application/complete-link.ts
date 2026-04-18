import type { Clock } from "@x1agent/kernel";
import type { AuthProvider } from "../ports/auth-provider.js";
import type { UserRepository } from "../ports/user-repository.js";
import type { PersonRepository } from "../ports/person-repository.js";
import type { LinkAttemptStore } from "../ports/link-attempt-store.js";
import type { LinkState } from "../domain/link-attempt.js";
import { assertNotExpired } from "../domain/link-attempt.js";
import type { User } from "../domain/user.js";
import {
  CrossPersonLinkError,
  LinkAttemptNotFoundError,
} from "../domain/errors.js";
import { assertAllowedDomain } from "../domain/auth-profile.js";

export interface CompleteLinkDeps {
  authProvider: AuthProvider;
  users: UserRepository;
  persons: PersonRepository;
  linkAttempts: LinkAttemptStore;
  clock: Clock;
  allowedDomains: readonly string[];
}

export interface CompleteLinkInput {
  state: LinkState;
  code: string;
  redirectUri: string;
}

export interface CompleteLinkResult {
  linkedUser: User;
}

/**
 * Accept a Google OAuth callback that carries an account-link state.
 * Validates the state, exchanges the code, enforces the cross-person
 * guard, creates/refreshes the user row, and attaches it to the
 * initiating person. Idempotent on the (email, same-person) case.
 */
export async function completeLink(
  deps: CompleteLinkDeps,
  input: CompleteLinkInput,
): Promise<CompleteLinkResult> {
  const attempt = await deps.linkAttempts.consume(input.state);
  if (!attempt) throw new LinkAttemptNotFoundError();
  assertNotExpired(attempt, deps.clock.now());

  const rawProfile = await deps.authProvider.exchangeCode(
    input.code,
    input.redirectUri,
  );
  const profile = assertAllowedDomain(rawProfile, deps.allowedDomains);

  const existingPersonForEmail = await deps.persons.findPersonIdForEmail(
    profile.email,
  );
  if (
    existingPersonForEmail &&
    existingPersonForEmail !== attempt.initiatingPersonId
  ) {
    throw new CrossPersonLinkError(
      profile.email,
      existingPersonForEmail,
      attempt.initiatingPersonId,
    );
  }

  const user = await deps.users.upsertFromProfile(profile);
  await deps.persons.attachUser(user.id, attempt.initiatingPersonId);

  return { linkedUser: user };
}
