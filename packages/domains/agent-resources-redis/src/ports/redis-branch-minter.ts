import type { SharedResource } from "@x1agent/agent-resources";
import type { RedisBranchCredential } from "../domain/redis-branch.js";

export interface MintRedisBranchInput {
  resource: SharedResource;
  namespace: string;
  repoFullName: string;
  branchName: string;
  branchId: string;
}

/**
 * Mints / rotates the per-(repo, branch) ACL user. Idempotent: on a
 * new branch the user is created with `ACL SETUSER`; on revisit only
 * the password rotates. The key/channel pattern restriction (`~prefix:*`
 * `&prefix:*`) is applied on every call so configuration can't drift.
 */
export interface RedisBranchMinter {
  mint(input: MintRedisBranchInput): Promise<RedisBranchCredential>;

  revokeBranch(input: {
    resource: SharedResource;
    namespace: string;
    branchId: string;
  }): Promise<void>;
}
