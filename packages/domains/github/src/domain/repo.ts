import { DomainError } from "@x1agent/kernel";

/**
 * A repository reachable via a GitHub App installation. Keyed by the
 * install + full name (`owner/repo`). Does not represent ownership —
 * installations can include repos across multiple orgs if the installer
 * chose "all repos" at install time.
 */
export interface InstallationRepo {
  fullName: string;      // "owner/repo"
  id: number;            // GitHub's numeric repo id
  defaultBranch: string;
  private: boolean;
}

export class RepoNotInInstallationError extends DomainError {
  readonly code = "repo_not_in_installation";
  constructor(
    public readonly fullName: string,
    public readonly installationId: number,
  ) {
    super(
      `repo ${fullName} is not visible to installation ${installationId}`,
    );
  }
}

export class RepoInstallationMismatchError extends DomainError {
  readonly code = "repo_installation_mismatch";
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `agent is linked to installation ${expected}; cannot attach repos from installation ${actual}`,
    );
  }
}
