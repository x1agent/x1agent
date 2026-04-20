import { branchId, type SharedResource } from "@x1agent/agent-resources";
import type { RedisBranchCredential } from "../domain/redis-branch.js";
import type { RedisBranchMinter } from "../ports/redis-branch-minter.js";
import type { RedisBranchRepository } from "../ports/redis-branch-repository.js";

export interface MintRedisBranchCommand {
  resource: SharedResource;
  namespace: string;
  repoFullName: string;
  branchName: string;
}

export async function mintRedisBranchCredential(
  minter: RedisBranchMinter,
  branches: RedisBranchRepository,
  command: MintRedisBranchCommand,
): Promise<RedisBranchCredential> {
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
