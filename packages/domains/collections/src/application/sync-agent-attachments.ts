import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import {
  CollectionNotFoundError,
  type CollectionId,
} from "../domain/collection.js";
import type { CollectionRepository } from "../ports/collection-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import { DomainError } from "@x1agent/kernel";

class DefaultNotInSetError extends DomainError {
  readonly code = "default_not_in_attachment_set";
  constructor() {
    super("defaultCollectionId must be one of the supplied collectionIds");
  }
}

export interface SyncAttachmentsCommand {
  actor: UserId;
  workspaceId: WorkspaceId;
  agentId: AgentId;
  /** Final desired set of attached collection ids. Empty = detach all. */
  collectionIds: readonly CollectionId[];
  /** Must be a member of `collectionIds`, or null. */
  defaultCollectionId: CollectionId | null;
}

export interface SyncAttachmentsDeps {
  collections: CollectionRepository;
  adminGuard: AdminGuard;
}

/**
 * Replaces an agent's collection attachments to match `collectionIds`.
 * Cross-workspace ids are rejected up-front so a malicious caller
 * can't link an agent in workspace A to a collection in workspace B.
 * The default must be in the set (or null).
 */
export async function syncAgentAttachments(
  deps: SyncAttachmentsDeps,
  cmd: SyncAttachmentsCommand,
): Promise<void> {
  await deps.adminGuard.assertAdmin(cmd.actor, cmd.workspaceId);

  if (cmd.defaultCollectionId !== null) {
    if (!cmd.collectionIds.includes(cmd.defaultCollectionId))
      throw new DefaultNotInSetError();
  }

  // Reject ids that don't exist in this workspace — otherwise
  // repository.syncAttachments would silently drop them and the UI
  // could show a stale "attached" row.
  for (const id of cmd.collectionIds) {
    const col = await deps.collections.findById(id);
    if (!col || col.workspaceId !== cmd.workspaceId)
      throw new CollectionNotFoundError(id);
  }

  await deps.collections.syncAttachments(
    cmd.agentId,
    cmd.workspaceId,
    cmd.collectionIds,
    cmd.defaultCollectionId,
  );
}
