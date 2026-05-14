import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import type {
  AgentCollectionAttachment,
  Collection,
  CollectionId,
  CollectionProviderType,
  CollectionSlug,
} from "../domain/collection.js";

export interface CreateCollectionInput {
  workspaceId: WorkspaceId;
  name: string;
  slug: CollectionSlug;
  description: string | null;
  providerType: CollectionProviderType;
  backendHandle: string;
  /** Per-workspace SurrealDB namespace — see t03 P0 #2 Layer 2. */
  backendNamespace: string;
  settings: Record<string, unknown>;
  createdBy: UserId | null;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string | null;
  settings?: Record<string, unknown>;
}

export interface AttachInput {
  agentId: AgentId;
  collectionId: CollectionId;
  isDefault: boolean;
}

export interface CollectionRepository {
  create(input: CreateCollectionInput): Promise<Collection>;

  findById(id: CollectionId): Promise<Collection | null>;

  findBySlug(
    workspaceId: WorkspaceId,
    slug: CollectionSlug,
  ): Promise<Collection | null>;

  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly Collection[]>;

  update(
    id: CollectionId,
    patch: UpdateCollectionInput,
  ): Promise<Collection>;

  delete(id: CollectionId): Promise<void>;

  // Agent attachments
  listForAgent(agentId: AgentId): Promise<readonly AgentCollectionAttachment[]>;

  listCollectionsForAgent(
    agentId: AgentId,
  ): Promise<readonly (Collection & { isDefault: boolean })[]>;

  attach(input: AttachInput): Promise<AgentCollectionAttachment>;

  detach(agentId: AgentId, collectionId: CollectionId): Promise<void>;

  /**
   * Atomic "set exactly this set of attachments" — diffs against
   * existing rows, inserts the new, deletes the removed, promotes
   * `defaultCollectionId` to `is_default=true` (demoting the old
   * default in the same transaction). Powers the UI card that shows
   * a checkboxed list.
   */
  syncAttachments(
    agentId: AgentId,
    workspaceId: WorkspaceId,
    collectionIds: readonly CollectionId[],
    defaultCollectionId: CollectionId | null,
  ): Promise<void>;
}
