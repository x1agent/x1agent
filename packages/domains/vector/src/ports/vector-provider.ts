import type { VectorNamespace } from "../domain/namespace.js";

export interface ProvisionInput {
  namespace: VectorNamespace;
  /** Dimension of every vector in this namespace. Immutable per namespace. */
  dimension: number;
  /**
   * Distance metric. Cosine is the default because agents typically
   * write normalised text embeddings; adapters that don't support a
   * metric throw invalid_argument.
   */
  metric: "cosine" | "l2" | "dot";
}

export interface UpsertInput {
  namespace: VectorNamespace;
  /** Opaque per-caller id. If it already exists the vector is replaced. */
  id: string;
  vector: readonly number[];
  /** Free-form metadata stored alongside the vector for filtering + display. */
  metadata: Record<string, unknown>;
}

export interface SearchInput {
  namespace: VectorNamespace;
  vector: readonly number[];
  topK: number;
  /**
   * Metadata equality filter. Adapters that can push this to the
   * engine should; in-memory fake applies it after scoring. All values
   * must match.
   */
  filter: Record<string, unknown>;
}

export interface SearchHit {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  hits: readonly SearchHit[];
}

/**
 * Port every vector-provider adapter implements. One namespace per
 * collection; `provision` creates it with a fixed dimension + metric,
 * `deprovision` drops it. Agents call `upsert` as they accrete
 * knowledge and `search` when they want semantic recall.
 */
export interface VectorProvider {
  readonly id: string;

  provision(input: ProvisionInput): Promise<void>;
  deprovision(namespace: VectorNamespace): Promise<void>;

  upsert(input: UpsertInput): Promise<void>;
  search(input: SearchInput): Promise<SearchResult>;
  delete(namespace: VectorNamespace, id: string): Promise<void>;
}
