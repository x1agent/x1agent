import { WorkspaceSlug, type UserId, type WorkspaceId } from "@x1agent/kernel";
import { CollectionHandle } from "@x1agent/domain-graph";
import {
  buildBackendHandle,
  type Collection,
  type CollectionProviderType,
  type CollectionSlug,
  CollectionSlugTakenError,
} from "../domain/collection.js";
import type { CollectionRepository } from "../ports/collection-repository.js";
import type { ProviderGateway } from "../ports/provider-gateway.js";
import type { AdminGuard } from "../ports/admin-guard.js";

export interface CreateCollectionCommand {
  actor: UserId;
  workspaceId: WorkspaceId;
  workspaceSlug: WorkspaceSlug;
  name: string;
  slug: CollectionSlug;
  description: string | null;
  providerType: CollectionProviderType;
  settings: Record<string, unknown>;
}

export interface CreateCollectionDeps {
  collections: CollectionRepository;
  adminGuard: AdminGuard;
  providers: ProviderGateway;
}

/**
 * Two-phase: insert the row, then ask the provider to create the
 * backing store. If provisioning fails we leave the row in place and
 * surface the provider error — the UI can show "pending" / "failed
 * to provision" and the operator can retry. Deleting the Postgres row
 * on provider failure would hide the error and leak the slug.
 */
export async function createCollection(
  deps: CreateCollectionDeps,
  cmd: CreateCollectionCommand,
): Promise<Collection> {
  await deps.adminGuard.assertAdmin(cmd.actor, cmd.workspaceId);

  const existing = await deps.collections.findBySlug(
    cmd.workspaceId,
    cmd.slug,
  );
  if (existing) throw new CollectionSlugTakenError(cmd.slug);

  const handle = CollectionHandle(
    buildBackendHandle(cmd.workspaceSlug, cmd.slug),
  );

  const collection = await deps.collections.create({
    workspaceId: cmd.workspaceId,
    name: cmd.name,
    slug: cmd.slug,
    description: cmd.description,
    providerType: cmd.providerType,
    backendHandle: handle,
    settings: cmd.settings,
    createdBy: cmd.actor,
  });

  await deps.providers.provision(cmd.providerType, handle, cmd.settings);

  return collection;
}
