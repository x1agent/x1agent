import type { SharedResourceId } from "@x1agent/agent-resources";
import type {
  RedisBranch,
  RedisBranchRowId,
} from "../domain/redis-branch.js";

export interface FindRedisBranchInput {
  resourceId: SharedResourceId;
  repoFullName: string;
  branchName: string;
}

export interface UpsertRedisBranchInput extends FindRedisBranchInput {
  branchId: string;
}

export interface RedisBranchRepository {
  find(input: FindRedisBranchInput): Promise<RedisBranch | null>;
  upsert(input: UpsertRedisBranchInput): Promise<RedisBranch>;
  listActiveByResource(
    resourceId: SharedResourceId,
  ): Promise<readonly RedisBranch[]>;
  markReaped(id: RedisBranchRowId): Promise<void>;
}
