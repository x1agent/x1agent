import { branchId, type SharedResource } from "@x1agent/agent-resources";
import type { BranchCredential } from "../domain/postgres-branch.js";
import type { PostgresBranchMinter } from "../ports/postgres-branch-minter.js";
import type { PostgresBranchRepository } from "../ports/postgres-branch-repository.js";

export interface MintPostgresBranchCommand {
  resource: SharedResource;
  namespace: string;
  repoFullName: string;
  branchName: string;
}

/**
 * Session-start path. Ensures the (repo, branch) has a provisioned DB +
 * role in the resource's Postgres instance and returns a freshly-rotated
 * credential the caller can inject into the session pod's env.
 */
export async function mintPostgresBranchCredential(
  minter: PostgresBranchMinter,
  branches: PostgresBranchRepository,
  command: MintPostgresBranchCommand,
): Promise<BranchCredential> {
  const bid = branchId(command.repoFullName, command.branchName);

  const credential = await minter.mint({
    resource: command.resource,
    namespace: command.namespace,
    repoFullName: command.repoFullName,
    branchName: command.branchName,
    branchId: bid,
  });

  await branches.upsert({
    resourceId: command.resource.id,
    repoFullName: command.repoFullName,
    branchName: command.branchName,
    branchId: bid,
  });

  return credential;
}
