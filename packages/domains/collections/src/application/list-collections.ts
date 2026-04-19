import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { Collection } from "../domain/collection.js";
import type { CollectionRepository } from "../ports/collection-repository.js";

export interface ListCollectionsDeps {
  collections: CollectionRepository;
}

/** Reading is membership-only; the api middleware already verified the
 *  caller is a member before routing here. No admin gate. */
export async function listCollections(
  deps: ListCollectionsDeps,
  _actor: UserId,
  workspaceId: WorkspaceId,
): Promise<readonly Collection[]> {
  return deps.collections.listByWorkspace(workspaceId);
}
