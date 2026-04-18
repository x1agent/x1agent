import { DomainError } from "@x1agent/kernel";
import type { PersonId } from "./person.js";

export class DomainNotAllowedError extends DomainError {
  readonly code = "domain_not_allowed";
  constructor(
    public readonly domain: string,
    public readonly allowed: readonly string[],
  ) {
    super(`Domain ${domain} is not in the allowlist`);
  }
}

export class NoWorkspaceMembershipError extends DomainError {
  readonly code = "no_workspace_membership";
  constructor(public readonly email: string) {
    super(`User ${email} has no workspace memberships`);
  }
}

export class InvalidAuthCodeError extends DomainError {
  readonly code = "invalid_auth_code";
  constructor(message = "the authorization code was rejected by the provider") {
    super(message);
  }
}

export class SessionVerificationError extends DomainError {
  readonly code = "session_invalid";
  constructor(message = "session token is invalid or expired") {
    super(message);
  }
}

/**
 * A link attempt tried to attach a Google identity whose email is
 * already tied to a DIFFERENT person. Blocking this is how we prevent
 * one human from stealing another human's user by claiming their email.
 */
export class CrossPersonLinkError extends DomainError {
  readonly code = "cross_person_link";
  constructor(
    public readonly email: string,
    public readonly existingPersonId: PersonId,
    public readonly attemptedPersonId: PersonId,
  ) {
    super(
      `cannot link ${email}: that Google identity already belongs to a different person`,
    );
  }
}

export class LinkAttemptNotFoundError extends DomainError {
  readonly code = "link_attempt_not_found";
  constructor() {
    super("no pending account-link attempt matches the provided state");
  }
}

export class LinkAttemptExpiredError extends DomainError {
  readonly code = "link_attempt_expired";
  constructor() {
    super("account-link attempt has expired; restart the Add Account flow");
  }
}
