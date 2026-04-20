import { DomainError } from "@x1agent/kernel";
import type { SharedResourceId } from "@x1agent/agent-resources";

declare const pgBranchIdBrand: unique symbol;
export type PostgresBranchRowId = string & {
  readonly [pgBranchIdBrand]: true;
};
export const PostgresBranchRowId = (raw: string): PostgresBranchRowId =>
  raw as PostgresBranchRowId;

/**
 * The metadata row for one per-branch database in a workspace's Postgres
 * instance. `branchId` is the sanitized + hashed identifier used as the
 * actual database name and owner role name — see agent-resources.branchId.
 */
export interface PostgresBranch {
  id: PostgresBranchRowId;
  resourceId: SharedResourceId;
  repoFullName: string;
  branchName: string;
  branchId: string;
  lastUsedAt: Date;
  reapedAt: Date | null;
  createdAt: Date;
}

/**
 * Value returned to the caller by the minter. Carries the DSN that will be
 * injected into the agent pod as DATABASE_URL plus the raw parts so the
 * caller can assemble alternate env shapes (e.g. split PG_HOST / PG_USER).
 */
export interface BranchCredential {
  dsn: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class BranchNotProvisionedError extends DomainError {
  readonly code = "branch_not_provisioned";
  constructor(
    public readonly repoFullName: string,
    public readonly branchName: string,
  ) {
    super(
      `no Postgres branch has been provisioned for ${repoFullName}@${branchName}`,
    );
  }
}
