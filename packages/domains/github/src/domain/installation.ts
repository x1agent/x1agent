import { DomainError, type UserId } from "@x1agent/kernel";

declare const installationIdBrand: unique symbol;
/** GitHub's own installation id. Opaque to us beyond being a positive int. */
export type InstallationId = number & { readonly [installationIdBrand]: true };
export const InstallationId = (n: number): InstallationId => {
  if (!Number.isInteger(n) || n <= 0)
    throw new ValidationErrorPlaceholder("installation_id must be a positive integer");
  return n as InstallationId;
};

// kernel's ValidationError expects a field name + message, so we wrap here.
import { ValidationError } from "@x1agent/kernel";
class ValidationErrorPlaceholder extends ValidationError {
  constructor(message: string) {
    super("installation_id", message);
  }
}

export type AccountType = "User" | "Organization";

export interface Installation {
  id: string;                        // our uuid pk
  installationId: InstallationId;    // GitHub's install id
  accountLogin: string;
  accountType: AccountType;
  installedByUserId: UserId;
  repositorySelection: "all" | "selected";
  createdAt: Date;
  revokedAt: Date | null;
}

export class InstallationNotFoundError extends DomainError {
  readonly code = "installation_not_found";
  constructor(public readonly installationId: number) {
    super(`installation ${installationId} not found`);
  }
}

export class InstallationNotOwnedError extends DomainError {
  readonly code = "installation_not_owned";
  constructor(
    public readonly installationId: number,
    public readonly actor: UserId,
  ) {
    super(`user ${actor} did not install installation ${installationId}`);
  }
}
