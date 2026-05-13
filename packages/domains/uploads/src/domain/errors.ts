import { DomainError } from "@x1agent/kernel";

export class UploadNotFoundError extends DomainError {
  readonly code = "upload_not_found";
  constructor() {
    super("upload not found");
  }
}

export class UploadTooLargeError extends DomainError {
  readonly code = "upload_too_large";
  constructor(public readonly limit: number) {
    super(`upload exceeds maximum size of ${limit} bytes`);
  }
}

export class UploadMimeNotAllowedError extends DomainError {
  readonly code = "mime_not_allowed";
  constructor(public readonly mime: string) {
    super(`mime ${mime} is not in the allowed list`);
  }
}

/** Sniffed MIME disagrees with the client hint. */
export class UploadMimeMismatchError extends DomainError {
  readonly code = "mime_mismatch";
  constructor(
    public readonly hint: string,
    public readonly sniffed: string | null,
  ) {
    super(`sniffed mime ${sniffed} does not match hint ${hint}`);
  }
}

/** Stored size disagrees with the size declared at init. */
export class UploadSizeMismatchError extends DomainError {
  readonly code = "size_mismatch";
  constructor(
    public readonly declared: number,
    public readonly actual: number,
  ) {
    super(`declared size ${declared} does not match actual ${actual}`);
  }
}

export class UploadAlreadyCompletedError extends DomainError {
  readonly code = "upload_already_completed";
  constructor() {
    super("upload has already been completed");
  }
}

export class UploadExpiredError extends DomainError {
  readonly code = "upload_expired";
  constructor() {
    super("upload has expired");
  }
}

/** Caller is not the creator of this upload. Map to 404 (don't leak). */
export class UploadNotOwnedError extends DomainError {
  readonly code = "upload_not_owned";
  constructor() {
    super("upload is not owned by the caller");
  }
}
