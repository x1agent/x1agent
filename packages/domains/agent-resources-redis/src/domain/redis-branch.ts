import { DomainError } from "@x1agent/kernel";
import type { SharedResourceId } from "@x1agent/agent-resources";

declare const redisBranchIdBrand: unique symbol;
export type RedisBranchRowId = string & {
  readonly [redisBranchIdBrand]: true;
};
export const RedisBranchRowId = (raw: string): RedisBranchRowId =>
  raw as RedisBranchRowId;

/**
 * Per-(repo, branch) Redis metadata row. `branchId` is the ACL username
 * and the key/channel prefix. Shared-agent-resources.branchId() computes
 * it once; both postgres and redis packages reuse that function.
 */
export interface RedisBranch {
  id: RedisBranchRowId;
  resourceId: SharedResourceId;
  repoFullName: string;
  branchName: string;
  branchId: string;
  lastUsedAt: Date;
  reapedAt: Date | null;
  createdAt: Date;
}

/**
 * Credential the minter hands back per session. The agent sees the DSN
 * as REDIS_URL in env; `userPrefix` is the prefix the server enforces
 * on every key/channel via ACL `~prefix:*` and `&prefix:*` patterns.
 */
export interface RedisBranchCredential {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  userPrefix: string;
}

export class RedisBranchNotProvisionedError extends DomainError {
  readonly code = "redis_branch_not_provisioned";
  constructor(
    public readonly repoFullName: string,
    public readonly branchName: string,
  ) {
    super(
      `no Redis branch has been provisioned for ${repoFullName}@${branchName}`,
    );
  }
}
