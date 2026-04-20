import type { SharedResourceId } from "@x1agent/agent-resources";
import type {
  PostgresBranch,
  PostgresBranchRowId,
} from "../domain/postgres-branch.js";

export interface FindBranchInput {
  resourceId: SharedResourceId;
  repoFullName: string;
  branchName: string;
}

export interface UpsertBranchInput extends FindBranchInput {
  branchId: string;
}

export interface PostgresBranchRepository {
  /**
   * Look up the row for (resource, repo, branch), skipping reaped rows.
   * Returns null if the branch has never been provisioned.
   */
  find(input: FindBranchInput): Promise<PostgresBranch | null>;

  /**
   * Idempotent upsert. Creates the row on first call for a (resource,
   * repo, branch) triple; on subsequent calls bumps lastUsedAt and
   * returns the existing row.
   */
  upsert(input: UpsertBranchInput): Promise<PostgresBranch>;

  listActiveByResource(
    resourceId: SharedResourceId,
  ): Promise<readonly PostgresBranch[]>;

  markReaped(id: PostgresBranchRowId): Promise<void>;
}
