import {
  DomainError,
  ValidationError,
  WorkspaceSlug,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  CollectionHandle,
  WorkspaceNamespace,
  workspaceNamespaceFromSlug,
} from "@x1agent/domain-graph";

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
  /**
   * Per-collection database name inside the workspace's SurrealDB
   * namespace. Paired with `backendNamespace` to fully address the
   * backing store — see t03 P0 #2 Layer 2.
   */
  backendHandle: CollectionHandle;
  /**
   * SurrealDB namespace that owns this collection. One namespace per
   * workspace; collections never live in a shared parent namespace.
   * Derived from the workspace slug at create time and stored on the
   * row so the api doesn't have to re-join `workspaces` on every
   * read.
   */
  backendNamespace: WorkspaceNamespace;
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

/**
 * Build the full (namespace, database) address from workspace +
 * collection slugs. The namespace is per-workspace (`ws_<slug>`); the
 * database is per-collection (`col_<workspace>_<slug>`). Returning the
 * tuple from one function (instead of two callers concatenating into
 * a single opaque string) is the load-bearing structural change for
 * t03 P0 #2 Layer 2 — without it there's no place for a per-request
 * `surreal-ns` pin to come from.
 */
export function buildCollectionAddress(
  workspaceSlug: WorkspaceSlug,
  collectionSlug: CollectionSlug,
): { namespace: WorkspaceNamespace; database: CollectionHandle } {
  return {
    namespace: workspaceNamespaceFromSlug(workspaceSlug),
    database: CollectionHandle(
      `col_${workspaceSlug.replace(/-/g, "_")}_${collectionSlug.replace(/-/g, "_")}`,
    ),
  };
}

/**
 * @deprecated Use `buildCollectionAddress`. Retained as a thin shim
 * during the Layer 2 rollout so any caller that still expects just
 * the database name string keeps compiling — they should be updated
 * to pass `backendNamespace` too.
 */
export function buildBackendHandle(
  workspaceSlug: WorkspaceSlug,
  collectionSlug: CollectionSlug,
): string {
  return buildCollectionAddress(workspaceSlug, collectionSlug).database;
}
