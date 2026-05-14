// initOtel before any auto-instrumented imports.
import { initOtel } from "@x1agent/observability";
initOtel({ serviceName: "x1agent-provider-graph-surrealdb" });

/**
 * graph-surrealdb provider service.
 *
 * One deployment subscribes to BOTH `x1.provider.graph.*` and
 * `x1.provider.vector.*` — SurrealDB v3 handles both domains natively,
 * so they share the connection and the credentials. A future setup
 * could split vector to a dedicated Turbopuffer provider without
 * touching this code; it would just mean unsubscribing from the
 * vector subjects and routing them elsewhere in Helm.
 *
 * Subjects handled:
 *   x1.provider.graph.provision       { handle }
 *   x1.provider.graph.deprovision     { handle }
 *   x1.provider.graph.query           { handle, query, vars }
 *   x1.provider.graph.write           { handle, record_type, data, provenance }
 *   x1.provider.graph.relate          { handle, from, edge, to, properties }
 *   x1.provider.graph.resolve         { handle, record_type, name, email, attributes }
 *   x1.provider.graph.discover        { handle }
 *
 *   x1.provider.vector.provision      { namespace, dimension, metric }
 *   x1.provider.vector.deprovision    { namespace }
 *   x1.provider.vector.upsert         { namespace, id, vector, metadata }
 *   x1.provider.vector.search         { namespace, vector, top_k, filter }
 *   x1.provider.vector.delete         { namespace, id }
 *
 * Every reply has shape `{ ok: boolean, result?, error?: {code, message} }`.
 */
import { connect, StringCodec, type Msg, type NatsConnection } from "nats";
import { DomainError } from "@x1agent/kernel";
import {
  CollectionHandle,
  SurrealClient,
  SurrealGraphProvider,
  WorkspaceNamespace,
  type CollectionAddress,
} from "@x1agent/domain-graph";
import {
  SurrealVectorProvider,
  VectorNamespace,
} from "@x1agent/domain-vector";

const NATS_URL = process.env.NATS_URL ?? "nats://nats:4222";
const SURREAL_URL = process.env.SURREAL_URL ?? "http://surrealdb:8000";
const SURREAL_USER = process.env.SURREAL_USER ?? "root";
const SURREAL_PASS = process.env.SURREAL_PASS ?? "x1agent-surreal-root";
const SURREAL_NS = process.env.SURREAL_NAMESPACE ?? "x1agent";

const client = new SurrealClient({
  url: SURREAL_URL,
  username: SURREAL_USER,
  password: SURREAL_PASS,
  namespace: SURREAL_NS,
});

const graph = new SurrealGraphProvider(client);
const vector = new SurrealVectorProvider(client);

interface ReplyOk<T> {
  ok: true;
  result: T;
}
interface ReplyErr {
  ok: false;
  error: { code: string; message: string };
}
type Reply<T> = ReplyOk<T> | ReplyErr;

function okReply<T>(result: T): Reply<T> {
  return { ok: true, result };
}
function errReply(err: unknown): ReplyErr {
  if (err instanceof DomainError)
    return { ok: false, error: { code: err.code, message: err.message } };
  return {
    ok: false,
    error: {
      code: "provider_error",
      message: (err as Error)?.message ?? String(err),
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function address(body: any): CollectionAddress {
  return {
    namespace: WorkspaceNamespace(String(body.namespace ?? "")),
    database: CollectionHandle(String(body.handle ?? "")),
  };
}

async function handleGraph(
  subject: string,
  body: any,
): Promise<Reply<unknown>> {
  try {
    switch (subject) {
      case "x1.provider.graph.provision":
        await graph.provision(address(body));
        return okReply({ provisioned: body.handle });
      case "x1.provider.graph.deprovision":
        await graph.deprovision(address(body));
        return okReply({ deprovisioned: body.handle });
      case "x1.provider.graph.query":
        return okReply(
          await graph.query({
            collection: address(body),
            query: String(body.query ?? ""),
            vars: body.vars ?? {},
          }),
        );
      case "x1.provider.graph.write": {
        const prov = body.provenance ?? {};
        return okReply(
          await graph.write({
            collection: address(body),
            recordType: String(body.record_type ?? ""),
            data: body.data ?? {},
            provenance: {
              sessionId: String(prov.session_id ?? ""),
              userId: prov.user_id ?? null,
              confidence:
                typeof prov.confidence === "number" ? prov.confidence : 1,
              source: prov.source ?? null,
              derivedFrom: prov.derived_from ?? [],
            },
          }),
        );
      }
      case "x1.provider.graph.relate":
        return okReply(
          await graph.relate({
            collection: address(body),
            from: String(body.from ?? ""),
            edge: String(body.edge ?? ""),
            to: String(body.to ?? ""),
            properties: body.properties ?? {},
          }),
        );
      case "x1.provider.graph.resolve":
        return okReply(
          await graph.resolve({
            collection: address(body),
            recordType: String(body.record_type ?? ""),
            name: body.name ?? null,
            email: body.email ?? null,
            attributes: body.attributes ?? {},
          }),
        );
      case "x1.provider.graph.discover":
        return okReply(await graph.discover(address(body)));
      default:
        return {
          ok: false,
          error: {
            code: "unknown_subject",
            message: `subject ${subject} not handled`,
          },
        };
    }
  } catch (err) {
    return errReply(err);
  }
}

async function handleVector(
  subject: string,
  body: any,
): Promise<Reply<unknown>> {
  try {
    // Wire shape: `namespace` is the workspace SurrealDB namespace
    // (ws_<slug>), `handle` is the per-collection database name.
    // Pre-Layer-2 the vector wire used `namespace` to mean the
    // database; the api gateway now sends both fields explicitly.
    const ws = WorkspaceNamespace(String(body.namespace ?? ""));
    const ns = VectorNamespace(String(body.handle ?? ""));
    switch (subject) {
      case "x1.provider.vector.provision":
        await vector.provision({
          workspaceNamespace: ws,
          namespace: ns,
          dimension: Number(body.dimension),
          metric: body.metric ?? "cosine",
        });
        return okReply({ provisioned: ns });
      case "x1.provider.vector.deprovision":
        await vector.deprovision(ws, ns);
        return okReply({ deprovisioned: ns });
      case "x1.provider.vector.upsert":
        await vector.upsert({
          workspaceNamespace: ws,
          namespace: ns,
          id: String(body.id ?? ""),
          vector: body.vector,
          metadata: body.metadata ?? {},
        });
        return okReply({ ok: true });
      case "x1.provider.vector.search":
        return okReply(
          await vector.search({
            workspaceNamespace: ws,
            namespace: ns,
            vector: body.vector,
            topK: Number(body.top_k ?? 10),
            filter: body.filter ?? {},
          }),
        );
      case "x1.provider.vector.delete":
        await vector.delete(ws, ns, String(body.id ?? ""));
        return okReply({ deleted: body.id });
      default:
        return {
          ok: false,
          error: {
            code: "unknown_subject",
            message: `subject ${subject} not handled`,
          },
        };
    }
  } catch (err) {
    return errReply(err);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function natsOpts() {
  const certFile = process.env.NATS_CLIENT_CERT;
  const keyFile = process.env.NATS_CLIENT_KEY;
  const caFile = process.env.NATS_CA_FILE;
  if (certFile && keyFile && caFile) {
    return { servers: NATS_URL, tls: { certFile, keyFile, caFile } } as const;
  }
  return { servers: NATS_URL } as const;
}

async function main(): Promise<void> {
  const nc: NatsConnection = await connect(natsOpts());
  const sc = StringCodec();
  console.log(`[graph-surrealdb] connected to ${NATS_URL}`);
  console.log(`[graph-surrealdb] SurrealDB at ${SURREAL_URL} ns=${SURREAL_NS}`);

  const subjects = [
    ...[
      "provision",
      "deprovision",
      "query",
      "write",
      "relate",
      "resolve",
      "discover",
    ].map((a) => `x1.provider.graph.${a}`),
    ...[
      "provision",
      "deprovision",
      "upsert",
      "search",
      "delete",
    ].map((a) => `x1.provider.vector.${a}`),
  ];

  for (const subject of subjects) {
    const sub = nc.subscribe(subject);
    (async () => {
      for await (const m of sub as AsyncIterable<Msg>) {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(sc.decode(m.data)) as Record<string, unknown>;
        } catch {
          // handler returns invalid_request via unknown_subject fallback
        }
        const reply = subject.startsWith("x1.provider.graph.")
          ? await handleGraph(subject, body)
          : await handleVector(subject, body);
        if (m.reply) nc.publish(m.reply, sc.encode(JSON.stringify(reply)));
      }
    })().catch((err) => {
      console.error(`[graph-surrealdb] subscription ${subject} crashed:`, err);
    });
  }
  console.log(`[graph-surrealdb] subscribed to ${subjects.length} subjects`);

  const shutdown = async () => {
    console.log("[graph-surrealdb] shutting down");
    await nc.drain();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
