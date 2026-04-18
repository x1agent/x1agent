import { DomainError } from "@x1agent/kernel";

export class InvitationNotFoundError extends DomainError {
  readonly code = "invitation_not_found";
  constructor() {
    super("invitation not found");
  }
}

export class InvitationAlreadyAcceptedError extends DomainError {
  readonly code = "invitation_already_accepted";
  constructor() {
    super("invitation has already been accepted");
  }
}

export class InvitationRevokedError extends DomainError {
  readonly code = "invitation_revoked";
  constructor() {
    super("invitation has been revoked");
  }
}

export class InvitationExpiredError extends DomainError {
  readonly code = "invitation_expired";
  constructor() {
    super("invitation has expired");
  }
}

export class InvitationEmailMismatchError extends DomainError {
  readonly code = "invitation_email_mismatch";
  constructor(
    public readonly invited: string,
    public readonly attempted: string,
  ) {
    super("invitation was issued to a different email");
  }
}

export class AlreadyMemberError extends DomainError {
  readonly code = "already_member";
  constructor() {
    super("user is already a member of this workspace");
  }
}

export class InvitationAlreadyPendingError extends DomainError {
  readonly code = "invitation_already_pending";
  constructor() {
    super("a pending invitation already exists for this email");
  }
}
