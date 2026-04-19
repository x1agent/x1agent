import { DomainError, type UserId, type WorkspaceId } from "@x1agent/kernel";
import {
  CollectionNotFoundError,
  type Collection,
  type CollectionId,
} from "../domain/collection.js";
import type {
  CollectionRepository,
  UpdateCollectionInput,
} from "../ports/collection-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";

class CollectionWrongWorkspaceError extends DomainError {
  readonly code = "collection_wrong_workspace";
  constructor() {
    super("collection does not belong to this workspace");
  }
}

export interface UpdateCollectionDeps {
  collections: CollectionRepository;
  adminGuard: AdminGuard;
}

export interface UpdateCollectionCommand {
  actor: UserId;
  workspaceId: WorkspaceId;
  collectionId: CollectionId;
  patch: UpdateCollectionInput;
}

export async function updateCollection(
  deps: UpdateCollectionDeps,
  cmd: UpdateCollectionCommand,
): Promise<Collection> {
  await deps.adminGuard.assertAdmin(cmd.actor, cmd.workspaceId);
  const existing = await deps.collections.findById(cmd.collectionId);
  if (!existing) throw new CollectionNotFoundError(cmd.collectionId);
  if (existing.workspaceId !== cmd.workspaceId)
    throw new CollectionWrongWorkspaceError();
  return deps.collections.update(cmd.collectionId, cmd.patch);
}
