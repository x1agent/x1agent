import { ValidationError } from "@x1agent/kernel";

/**
 * Provider-opaque identifier for a collection's backing store. The
 * SurrealDB adapter uses this as a database name ("col_default_ideas");
 * a future Neo4j adapter would use it as a graph label. The main
 * Postgres table `collections` stores one of these per row in
 * `backend_handle`. Format is constrained to keep backends honest —
 * lowercase, alphanumeric, underscores only.
 */
declare const collectionHandleBrand: unique symbol;
export type CollectionHandle = string & {
  readonly [collectionHandleBrand]: true;
};

const HANDLE_RE = /^[a-z][a-z0-9_]{0,62}$/;

export const CollectionHandle = (raw: string): CollectionHandle => {
  if (!HANDLE_RE.test(raw))
    throw new ValidationError(
      "collection_handle",
      "handle must be lowercase alphanumeric + underscore, 1-63 chars, start with a letter",
    );
  return raw as CollectionHandle;
};
