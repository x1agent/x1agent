import {
  DimensionMismatchError,
  VectorNamespaceNotProvisionedError,
} from "../domain/errors.js";
import type { VectorNamespace } from "../domain/namespace.js";
import type {
  ProvisionInput,
  SearchHit,
  SearchInput,
  SearchResult,
  UpsertInput,
  VectorProvider,
} from "../ports/vector-provider.js";

interface NamespaceState {
  dimension: number;
  metric: "cosine" | "l2" | "dot";
  vectors: Map<string, { vector: number[]; metadata: Record<string, unknown> }>;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aSq = 0;
  let bSq = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aSq += a[i]! * a[i]!;
    bSq += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(aSq) * Math.sqrt(bSq);
  return denom === 0 ? 0 : dot / denom;
}

function l2(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function matchesFilter(
  md: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (md[k] !== v) return false;
  }
  return true;
}

/** In-memory vector provider for tests. Scores with the chosen metric,
 *  applies the metadata filter after ranking (same order as a real
 *  engine's `filter`-then-`topK`), returns up to topK hits. Cosine and
 *  dot produce higher-is-better; l2 produces lower-is-better — we
 *  flip l2's sign for ranking consistency so "top by score desc" works
 *  identically regardless of metric. */
export class InMemoryVectorProvider implements VectorProvider {
  readonly id = "fake";
  readonly namespaces = new Map<VectorNamespace, NamespaceState>();

  async provision(input: ProvisionInput): Promise<void> {
    this.namespaces.set(input.namespace, {
      dimension: input.dimension,
      metric: input.metric,
      vectors: new Map(),
    });
  }

  async deprovision(namespace: VectorNamespace): Promise<void> {
    this.namespaces.delete(namespace);
  }

  private state(ns: VectorNamespace): NamespaceState {
    const s = this.namespaces.get(ns);
    if (!s) throw new VectorNamespaceNotProvisionedError(ns);
    return s;
  }

  async upsert(input: UpsertInput): Promise<void> {
    const s = this.state(input.namespace);
    if (input.vector.length !== s.dimension)
      throw new DimensionMismatchError(s.dimension, input.vector.length);
    s.vectors.set(input.id, {
      vector: [...input.vector],
      metadata: { ...input.metadata },
    });
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const s = this.state(input.namespace);
    if (input.vector.length !== s.dimension)
      throw new DimensionMismatchError(s.dimension, input.vector.length);

    const all: SearchHit[] = [];
    for (const [id, rec] of s.vectors) {
      if (!matchesFilter(rec.metadata, input.filter)) continue;
      const raw =
        s.metric === "cosine"
          ? cosine(input.vector, rec.vector)
          : s.metric === "dot"
            ? dot(input.vector, rec.vector)
            : -l2(input.vector, rec.vector);
      all.push({ id, score: raw, metadata: rec.metadata });
    }
    all.sort((a, b) => b.score - a.score);
    return { hits: all.slice(0, Math.max(0, input.topK)) };
  }

  async delete(namespace: VectorNamespace, id: string): Promise<void> {
    const s = this.state(namespace);
    s.vectors.delete(id);
  }
}
