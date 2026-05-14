import type { CollectionHandle } from "../domain/collection-handle.js";
import type { WorkspaceNamespace } from "../domain/workspace-namespace.js";
import type { GraphEdge, GraphRecord } from "../domain/record.js";
import type { RecordType } from "../domain/record-type.js";

/**
 * Pair that fully addresses a collection's backing store. The
 * SurrealDB namespace is per-workspace; the database is per-
 * collection. Carrying both at the port boundary (instead of the
 * old single-string handle) is the load-bearing structural change
 * for t03 P0 #2 Layer 2 — see `WorkspaceNamespace`'s docstring.
 */
export interface CollectionAddress {
  namespace: WorkspaceNamespace;
  database: CollectionHandle;
}

export interface QueryInput {
  collection: CollectionAddress;
  /** Backend-native query string. SurrealQL for SurrealDB, Cypher for Neo4j. */
  query: string;
  vars: Record<string, unknown>;
}

export interface QueryResult {
  /** Provider-native JSON — the sidecar passes this through to the agent. */
  rows: unknown;
}

export interface WriteInput {
  collection: CollectionAddress;
  recordType: string;
  data: Record<string, unknown>;
  provenance: {
    sessionId: string;
    userId: string | null;
    confidence: number;
    source: string | null;
    derivedFrom: readonly string[];
  };
}

export interface RelateInput {
  collection: CollectionAddress;
  from: string;
  edge: string;
  to: string;
  properties: Record<string, unknown>;
}

export interface ResolveInput {
  collection: CollectionAddress;
  recordType: string;
  /** Soft match hints. Adapters combine these with fuzzy + exact rules. */
  name: string | null;
  email: string | null;
  attributes: Record<string, unknown>;
}

/**
 * Port every graph-provider adapter implements. SurrealDB, Neo4j,
 * in-memory fake — all run the same contract-test suite.
 *
 * `provision` / `deprovision` are the lifecycle pair. The api calls
 * `provision` when a collection is created and `deprovision` when it
 * is deleted; both are idempotent (re-provisioning an existing
 * collection is a no-op, not an error).
 */
export interface GraphProvider {
  readonly id: string;

  provision(address: CollectionAddress): Promise<void>;
  deprovision(address: CollectionAddress): Promise<void>;

  query(input: QueryInput): Promise<QueryResult>;
  write(input: WriteInput): Promise<GraphRecord>;
  relate(input: RelateInput): Promise<GraphEdge>;
  resolve(input: ResolveInput): Promise<GraphRecord | null>;

  /**
   * Return the record-type registry for this collection — the types
   * seeded at provisioning plus any new ones agents have written into
   * the collection since. Backs the Collections UI detail page.
   */
  discover(address: CollectionAddress): Promise<readonly RecordType[]>;
}
