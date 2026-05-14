import { SurrealClient, type WorkspaceNamespace } from "@x1agent/domain-graph";
import {
  DimensionMismatchError,
  VectorNamespaceNotProvisionedError,
  VectorProviderUnreachableError,
} from "../../domain/errors.js";
import type { VectorNamespace } from "../../domain/namespace.js";
import type {
  ProvisionInput,
  SearchHit,
  SearchInput,
  SearchResult,
  UpsertInput,
  VectorProvider,
} from "../../ports/vector-provider.js";

interface SurrealResultEnvelope {
  result?: unknown;
  status?: "OK" | "ERR";
  detail?: string;
}

function unwrap(body: unknown): unknown {
  if (!Array.isArray(body) || body.length === 0) return null;
  const env = body[body.length - 1] as SurrealResultEnvelope;
  if (env.status === "ERR")
    throw new VectorProviderUnreachableError(
      "surrealdb",
      env.detail ?? "query error",
    );
  return env.result ?? null;
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * SurrealDB vector adapter. Each namespace maps to a `_vectors` table
 * in a database that lives inside the workspace's SurrealDB namespace
 * (`ws_<slug>`). `provision` defines the table + a VECTOR index sized
 * for the namespace; `upsert` writes rows keyed by caller-supplied id;
 * `search` runs `<||> vector::similarity::cosine` against the index.
 * Every call pins `surreal-ns` to the workspace namespace per request
 * for tenancy isolation — see t03 P0 #2 Layer 2.
 *
 * Metric routing: cosine maps to `cosine`, l2 to `euclidean`, dot to
 * `dot`. SurrealDB v3 returns higher-is-better for cosine and dot;
 * l2 is lower-is-better and we negate it for stable sort-desc.
 */
export class SurrealVectorProvider implements VectorProvider {
  readonly id = "surrealdb";

  constructor(private readonly client: SurrealClient) {}

  private metricFn(metric: "cosine" | "l2" | "dot"): string {
    switch (metric) {
      case "cosine":
        return "vector::similarity::cosine";
      case "l2":
        return "vector::distance::euclidean";
      case "dot":
        return "vector::similarity::dot";
    }
  }

  private async metricFor(
    ns: WorkspaceNamespace,
    namespace: VectorNamespace,
  ): Promise<"cosine" | "l2" | "dot"> {
    const body = (await this.client.sql(
      `SELECT metric FROM _vector_meta:config;`,
      namespace,
      { ns },
    )) as SurrealResultEnvelope[];
    const rows = unwrap(body);
    if (!Array.isArray(rows) || rows.length === 0)
      throw new VectorNamespaceNotProvisionedError(namespace);
    const m = (rows[0] as Record<string, unknown>)["metric"];
    if (m === "cosine" || m === "l2" || m === "dot") return m;
    throw new VectorNamespaceNotProvisionedError(namespace);
  }

  private async dimensionFor(
    ns: WorkspaceNamespace,
    namespace: VectorNamespace,
  ): Promise<number> {
    const body = (await this.client.sql(
      `SELECT dimension FROM _vector_meta:config;`,
      namespace,
      { ns },
    )) as SurrealResultEnvelope[];
    const rows = unwrap(body);
    if (!Array.isArray(rows) || rows.length === 0)
      throw new VectorNamespaceNotProvisionedError(namespace);
    const d = (rows[0] as Record<string, unknown>)["dimension"];
    if (typeof d !== "number")
      throw new VectorNamespaceNotProvisionedError(namespace);
    return d;
  }

  async provision(input: ProvisionInput): Promise<void> {
    // Workspace namespace bootstrap. provision/deprovision are the
    // only paths that legitimately ship multi-statement DDL (Layer 3,
    // t03 P0 #2). The graph provider's provision also creates the
    // namespace; calling DEFINE NAMESPACE again here is harmless.
    await this.client.sql(
      `DEFINE NAMESPACE IF NOT EXISTS ${input.workspaceNamespace};`,
      null,
      { allowMultiStatement: true, ns: input.workspaceNamespace },
    );
    await this.client.sql(
      `DEFINE DATABASE IF NOT EXISTS ${input.namespace};`,
      null,
      { allowMultiStatement: true, ns: input.workspaceNamespace },
    );
    const ddl = [
      `DEFINE TABLE IF NOT EXISTS _vectors SCHEMAFULL;`,
      `DEFINE FIELD IF NOT EXISTS embedding ON _vectors TYPE array<float>;`,
      `DEFINE FIELD IF NOT EXISTS metadata ON _vectors FLEXIBLE TYPE object DEFAULT {};`,
      `DEFINE INDEX IF NOT EXISTS _vectors_embedding_idx ON _vectors FIELDS embedding HNSW DIMENSION ${input.dimension} DIST ${input.metric === "l2" ? "EUCLIDEAN" : input.metric === "dot" ? "DOT" : "COSINE"};`,
      `DEFINE TABLE IF NOT EXISTS _vector_meta SCHEMALESS;`,
      `UPSERT _vector_meta:config SET dimension = ${input.dimension}, metric = ${quote(input.metric)};`,
    ];
    await this.client.sql(ddl.join("\n"), input.namespace, {
      allowMultiStatement: true,
      ns: input.workspaceNamespace,
    });
  }

  async deprovision(
    workspaceNamespace: WorkspaceNamespace,
    namespace: VectorNamespace,
  ): Promise<void> {
    try {
      await this.client.sql(
        `REMOVE DATABASE IF EXISTS ${namespace};`,
        null,
        { allowMultiStatement: true, ns: workspaceNamespace },
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code && code !== "graph_provider_unreachable") throw err;
    }
  }

  async upsert(input: UpsertInput): Promise<void> {
    const dim = await this.dimensionFor(
      input.workspaceNamespace,
      input.namespace,
    );
    if (input.vector.length !== dim)
      throw new DimensionMismatchError(dim, input.vector.length);

    const sql = `UPSERT _vectors:${quoteId(input.id)} SET embedding = ${JSON.stringify([...input.vector])}, metadata = ${JSON.stringify(input.metadata ?? {})};`;
    await this.client.sql(sql, input.namespace, {
      ns: input.workspaceNamespace,
    });
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const dim = await this.dimensionFor(
      input.workspaceNamespace,
      input.namespace,
    );
    if (input.vector.length !== dim)
      throw new DimensionMismatchError(dim, input.vector.length);

    const metric = await this.metricFor(
      input.workspaceNamespace,
      input.namespace,
    );
    const fn = this.metricFn(metric);
    const filterWheres = Object.entries(input.filter ?? {}).map(
      ([k, v]) => `metadata.${k} = ${typeof v === "string" ? quote(v) : JSON.stringify(v)}`,
    );
    const where = filterWheres.length > 0 ? `WHERE ${filterWheres.join(" AND ")}` : "";
    const topK = Math.max(1, Math.min(1000, input.topK));
    const query = `SELECT id, metadata, ${fn}(embedding, ${JSON.stringify([...input.vector])}) AS score FROM _vectors ${where} ORDER BY score ${metric === "l2" ? "ASC" : "DESC"} LIMIT ${topK};`;
    const body = (await this.client.sql(query, input.namespace, {
      ns: input.workspaceNamespace,
    })) as SurrealResultEnvelope[];
    const rows = unwrap(body);
    if (!Array.isArray(rows)) return { hits: [] };

    const hits: SearchHit[] = rows.map((r) => {
      const row = r as Record<string, unknown>;
      const id = String(row["id"] ?? "").replace(/^_vectors:/, "");
      const raw = typeof row["score"] === "number" ? row["score"] : 0;
      return {
        id,
        score: metric === "l2" ? -raw : raw,
        metadata: (row["metadata"] as Record<string, unknown>) ?? {},
      };
    });
    return { hits };
  }

  async delete(
    workspaceNamespace: WorkspaceNamespace,
    namespace: VectorNamespace,
    id: string,
  ): Promise<void> {
    await this.client.sql(
      `DELETE _vectors:${quoteId(id)};`,
      namespace,
      { ns: workspaceNamespace },
    );
  }
}

/**
 * SurrealDB record ids accept `⟨arbitrary⟩` escaping. We pass the
 * caller id through that so ids with dashes / colons / slashes work.
 */
function quoteId(raw: string): string {
  return `⟨${raw.replace(/⟩/g, "")}⟩`;
}
