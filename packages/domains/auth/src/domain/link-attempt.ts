import type { PersonId } from "./person.js";
import { LinkAttemptExpiredError } from "./errors.js";

declare const linkStateBrand: unique symbol;
export type LinkState = string & { readonly [linkStateBrand]: true };
export const LinkState = (raw: string): LinkState => raw as LinkState;

/**
 * Short-lived record created when an authenticated user starts "Add
 * account." The state token round-trips through Google OAuth; the
 * callback looks it up to know which Person the newly authenticated
 * identity should join.
 */
export interface LinkAttempt {
  state: LinkState;
  initiatingPersonId: PersonId;
  createdAt: Date;
  expiresAt: Date;
}

export function assertNotExpired(attempt: LinkAttempt, now: Date): void {
  if (attempt.expiresAt.getTime() < now.getTime()) {
    throw new LinkAttemptExpiredError();
  }
}
