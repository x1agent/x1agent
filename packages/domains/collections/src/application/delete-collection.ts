import type { UserId, WorkspaceId } from "@x1agent/kernel";
import { CollectionHandle } from "@x1agent/domain-graph";
import {
  CollectionNotFoundError,
  type CollectionId,
} from "../domain/collection.js";
import type { CollectionRepository } from "../ports/collection-repository.js";
import type { ProviderGateway } from "../ports/provider-gateway.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import { DomainError } from "@x1agent/kernel";

class CollectionWrongWorkspaceError extends DomainError {
  readonly code = "collection_wrong_workspace";
  constructor() {
    super("collection does not belong to this workspace");
  }
}

export interface DeleteCollectionDeps {
  collections: CollectionRepository;
  adminGuard: AdminGuard;
  providers: ProviderGateway;
}

export interface DeleteCollectionCommand {
  actor: UserId;
  workspaceId: WorkspaceId;
  collectionId: CollectionId;
}

/**
 * Two-phase delete: ask the provider to drop its backing store, then
 * remove the row. Provider failure aborts the delete — the UI surfaces
 * the error, the operator retries. A partial delete where the
 * provider succeeded but Postgres didn't is survivable (re-provisioning
 * a handle that already exists is idempotent per contract).
 */
export async function deleteCollection(
  deps: DeleteCollectionDeps,
  cmd: DeleteCollectionCommand,
): Promise<void> {
  await deps.adminGuard.assertAdmin(cmd.actor, cmd.workspaceId);

  const c = await deps.collections.findById(cmd.collectionId);
  if (!c) throw new CollectionNotFoundError(cmd.collectionId);
  if (c.workspaceId !== cmd.workspaceId)
    throw new CollectionWrongWorkspaceError();

  await deps.providers.deprovision(
    c.providerType,
    CollectionHandle(c.backendHandle),
  );
  await deps.collections.delete(c.id);
}
