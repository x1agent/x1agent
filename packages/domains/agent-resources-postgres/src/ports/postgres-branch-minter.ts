import type { SharedResource } from "@x1agent/agent-resources";
import type { BranchCredential } from "../domain/postgres-branch.js";

export interface MintBranchInput {
  resource: SharedResource;
  namespace: string;
  repoFullName: string;
  branchName: string;
  /** The already-computed branchId for the DB and role name. */
  branchId: string;
}

/**
 * Mints or rotates credentials for a (resource, repo, branch) tuple.
 * Idempotent: the first call for a new branch creates the database and
 * role (CREATE DATABASE ... TEMPLATE ...); subsequent calls ALTER the
 * role's password.
 *
 * Returns a fresh credential every call — the password rotates per
 * session even though the DB and role persist.
 */
export interface PostgresBranchMinter {
  mint(input: MintBranchInput): Promise<BranchCredential>;

  /**
   * Called by the reaper or by explicit admin reset. Drops the database
   * and role for one (resource, repo, branch). Adapters are expected to
   * run these as two transactions; failures are surfaced so the caller
   * can retry.
   */
  revokeBranch(input: {
    resource: SharedResource;
    namespace: string;
    branchId: string;
  }): Promise<void>;
}
