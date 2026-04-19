import { connect, StringCodec, type NatsConnection } from "nats";
import type {
  CollectionProviderType,
  ProviderGateway,
  ProviderRecord,
  ProviderRecordType,
} from "@x1agent/domain-collections";
import type { CollectionHandle } from "@x1agent/domain-graph";

interface WireReply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * ProviderGateway implementation that fans a provision/deprovision
 * request out to BOTH the graph and vector subject trees for the
 * chosen provider type. The graph-surrealdb provider implements both
 * subjects from one deployment, so today the two requests hit the
 * same pod. A split setup (graph=surrealdb, vector=turbopuffer) would
 * fan to two providers with no change here.
 *
 * We fire the two requests sequentially — graph first, vector second
 * — because vector.provision picks a dimension + metric from settings
 * while graph.provision owns record-type seeding. Failure on either
 * surfaces the error; the caller leaves the Postgres row in place so
 * the UI can show "provisioning failed" and the operator retries.
 */
type VectorMetric = "cosine" | "l2" | "dot";

interface VectorSettings {
  dimension: number;
  metric: VectorMetric;
}

const DEFAULT_VECTOR: VectorSettings = {
  dimension: 1536, // OpenAI text-embedding-3-small
  metric: "cosine",
};

function resolveVectorSettings(
  settings: Record<string, unknown>,
): VectorSettings {
  const v = (settings.vector ?? {}) as Record<string, unknown>;
  const rawDim = v["dimension"];
  const rawMetric = v["metric"];
  const dimension =
    typeof rawDim === "number" && Number.isInteger(rawDim) && rawDim > 0
      ? rawDim
      : DEFAULT_VECTOR.dimension;
  const metric: VectorMetric =
    rawMetric === "cosine" || rawMetric === "l2" || rawMetric === "dot"
      ? rawMetric
      : DEFAULT_VECTOR.metric;
  return { dimension, metric };
}

export class NatsProviderGateway implements ProviderGateway {
  constructor(
    private readonly nc: NatsConnection,
    private readonly timeoutMs = 10_000,
  ) {}

  async provision(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
    settings: Record<string, unknown>,
  ): Promise<void> {
    void providerType;
    const vector = resolveVectorSettings(settings);
    await this.request("x1.provider.graph.provision", { handle });
    await this.request("x1.provider.vector.provision", {
      namespace: handle,
      dimension: vector.dimension,
      metric: vector.metric,
    });
  }

  async deprovision(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
  ): Promise<void> {
    void providerType;
    // Deprovision in reverse order so the graph DB is the last thing
    // to go — REMOVE DATABASE on the same db cleans up the vector
    // tables too, but calling vector.deprovision first keeps the
    // symmetry and makes a future split-provider setup (two different
    // DBs) Just Work.
    await this.request("x1.provider.vector.deprovision", {
      namespace: handle,
    });
    await this.request("x1.provider.graph.deprovision", { handle });
  }

  async discover(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
  ): Promise<readonly ProviderRecordType[]> {
    void providerType;
    const result = (await this.request("x1.provider.graph.discover", {
      handle,
    })) as
      | ReadonlyArray<{
          name?: unknown;
          slug?: unknown;
          description?: unknown;
          icon?: unknown;
          fields?: unknown;
          relationships?: unknown;
        }>
      | null;
    if (!Array.isArray(result)) return [];
    return result.map((r) => ({
      name: typeof r.name === "string" ? r.name : "",
      slug: typeof r.slug === "string" ? r.slug : "",
      description: typeof r.description === "string" ? r.description : "",
      icon: typeof r.icon === "string" ? r.icon : null,
      fields: Array.isArray(r.fields)
        ? (r.fields as ReadonlyArray<{
            name: string;
            type: string;
            required: boolean;
          }>)
        : [],
      relationships: Array.isArray(r.relationships)
        ? (r.relationships as ReadonlyArray<{
            name: string;
            targetType: string;
            edge: string;
          }>)
        : [],
    }));
  }

  async listRecords(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
    recordType: string,
    limit: number,
  ): Promise<readonly ProviderRecord[]> {
    void providerType;
    // Record-type slugs come from the provider's own registry (the
    // record-id form uses the slug directly), so we can splice them
    // into the query. We still reject anything other than
    // lowercase-snake to keep the query layer injection-free.
    if (!/^[a-z][a-z0-9_]*$/.test(recordType)) {
      throw Object.assign(new Error("invalid_record_type"), {
        code: "invalid_record_type",
      });
    }
    const safeLimit = Math.max(1, Math.min(500, limit));
    const queryResult = (await this.request("x1.provider.graph.query", {
      handle,
      query: `SELECT * FROM ${recordType} ORDER BY _provenance.created_at DESC LIMIT ${safeLimit};`,
      vars: {},
    })) as { rows?: unknown } | null;

    // SurrealDB returns [{ result: [...], status: 'OK' }]; unwrap the
    // last envelope's result.
    const outer = (queryResult?.rows ?? null) as unknown;
    if (!Array.isArray(outer) || outer.length === 0) return [];
    const last = outer[outer.length - 1] as { result?: unknown };
    const rows = Array.isArray(last?.result) ? last.result : [];
    return rows.map((raw) => this.toRecord(raw, recordType));
  }

  private toRecord(raw: unknown, recordType: string): ProviderRecord {
    const r = (raw ?? {}) as Record<string, unknown>;
    const prov = (r["_provenance"] ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "id" || k.startsWith("_")) continue;
      data[k] = v;
    }
    return {
      id: String(r["id"] ?? ""),
      recordType,
      data,
      provenance: {
        createdBy: String(prov["created_by"] ?? ""),
        createdByUserId:
          typeof prov["created_by_user"] === "string"
            ? (prov["created_by_user"] as string)
            : null,
        confidence:
          typeof prov["confidence"] === "number"
            ? (prov["confidence"] as number)
            : 1,
        source:
          typeof prov["source"] === "string" ? (prov["source"] as string) : null,
        derivedFrom: Array.isArray(prov["derived_from"])
          ? (prov["derived_from"] as string[])
          : [],
        createdAt:
          typeof prov["created_at"] === "string"
            ? (prov["created_at"] as string)
            : "",
      },
    };
  }

  private async request(
    subject: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const sc = StringCodec();
    const reply = await this.nc.request(
      subject,
      sc.encode(JSON.stringify(body)),
      { timeout: this.timeoutMs },
    );
    const parsed = JSON.parse(sc.decode(reply.data)) as WireReply;
    if (!parsed.ok) {
      const err = new Error(
        parsed.error?.message ?? `${subject} returned error`,
      );
      (err as Error & { code?: string }).code =
        parsed.error?.code ?? "provider_error";
      throw err;
    }
    return parsed.result;
  }
}

/**
 * Build NATS connect options, optionally with mTLS. Callers that want
 * TLS set NATS_CLIENT_CERT + NATS_CLIENT_KEY + NATS_CA_FILE to paths
 * mounted from the `nats-tls` Secret; without them the client speaks
 * plain text. Prod MUST set all three — nats.conf `verify: true`
 * rejects unauthenticated clients at the TLS handshake.
 */
export function natsConnectOpts(url: string) {
  const certFile = process.env.NATS_CLIENT_CERT;
  const keyFile = process.env.NATS_CLIENT_KEY;
  const caFile = process.env.NATS_CA_FILE;
  if (certFile && keyFile && caFile) {
    return {
      servers: url,
      tls: { certFile, keyFile, caFile },
    } as const;
  }
  return { servers: url } as const;
}

export async function connectNats(url: string): Promise<NatsConnection> {
  return connect(natsConnectOpts(url));
}
