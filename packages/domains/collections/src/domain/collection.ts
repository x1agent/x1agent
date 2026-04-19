import {
  DomainError,
  ValidationError,
  WorkspaceSlug,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import type { CollectionHandle } from "@x1agent/domain-graph";

declare const collectionIdBrand: unique symbol;
export type CollectionId = string & { readonly [collectionIdBrand]: true };
export const CollectionId = (raw: string): CollectionId => raw as CollectionId;

/**
 * Human-readable identifier used in URLs. Scoped to a workspace: two
 * workspaces can each have a "general" collection without colliding.
 */
declare const collectionSlugBrand: unique symbol;
export type CollectionSlug = string & {
  readonly [collectionSlugBrand]: true;
};
const SLUG_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const CollectionSlug = (raw: string): CollectionSlug => {
  if (!SLUG_RE.test(raw))
    throw new ValidationError(
      "collection_slug",
      "slug must be lowercase, kebab-case, 1-63 chars, start with a letter",
    );
  return raw as CollectionSlug;
};

/** Provider types known to the platform today. Extensible as new
 *  providers ship — keep the union small and document each one.  */
export type CollectionProviderType = "surrealdb";
const PROVIDER_TYPES: readonly CollectionProviderType[] = ["surrealdb"];
export const CollectionProviderType = (
  raw: string,
): CollectionProviderType => {
  if ((PROVIDER_TYPES as readonly string[]).includes(raw))
    return raw as CollectionProviderType;
  throw new ValidationError(
    "provider_type",
    `provider_type must be one of ${PROVIDER_TYPES.join(", ")}`,
  );
};

export interface Collection {
  id: CollectionId;
  workspaceId: WorkspaceId;
  name: string;
  slug: CollectionSlug;
  description: string | null;
  providerType: CollectionProviderType;
  backendHandle: CollectionHandle;
  settings: Record<string, unknown>;
  createdBy: UserId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentCollectionAttachment {
  agentId: string;
  collectionId: CollectionId;
  isDefault: boolean;
  attachedAt: Date;
}

export class CollectionNotFoundError extends DomainError {
  readonly code = "collection_not_found";
  constructor(public readonly ref: string) {
    super(`collection ${ref} not found`);
  }
}

export class CollectionSlugTakenError extends DomainError {
  readonly code = "collection_slug_taken";
  constructor(public readonly slug: string) {
    super(`a collection with slug ${slug} already exists in this workspace`);
  }
}

/** Build the provider-opaque backend handle from workspace + collection
 *  slugs. Kept here so the same construction is reused by tests,
 *  adapters, and the api. `col_<workspace>_<slug>` — underscores only. */
export function buildBackendHandle(
  workspaceSlug: WorkspaceSlug,
  collectionSlug: CollectionSlug,
): string {
  return `col_${workspaceSlug.replace(/-/g, "_")}_${collectionSlug.replace(/-/g, "_")}`;
}
