import {
  CollectionNotProvisionedError,
  InvalidGraphQueryError,
} from "../../domain/errors.js";
import {
  DEFAULT_RECORD_TYPES,
  type RecordField,
  type RecordRelationship,
  type RecordType,
} from "../../domain/record-type.js";
import type {
  GraphEdge,
  GraphRecord,
  RecordProvenance,
} from "../../domain/record.js";
import type {
  CollectionAddress,
  GraphProvider,
  QueryInput,
  QueryResult,
  RelateInput,
  ResolveInput,
  WriteInput,
} from "../../ports/graph-provider.js";
import { SurrealClient } from "./surreal-client.js";
import { assertSafeAgentQuery } from "./surreal-query-guard.js";

/** SurrealDB returns one result envelope per statement: { result, status, ... }. */
interface SurrealResultEnvelope {
  result?: unknown;
  status?: "OK" | "ERR";
  detail?: string;
}

function unwrapSingle(body: unknown): unknown {
  if (!Array.isArray(body) || body.length === 0) return null;
  const env = body[body.length - 1] as SurrealResultEnvelope;
  if (env.status === "ERR")
    throw new InvalidGraphQueryError(env.detail ?? "SurrealDB rejected the query");
  return env.result ?? null;
}

/** SurrealQL string literal escaping — double every backslash, escape single quotes. */
function quote(raw: string): string {
  return `'${raw.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function jsonify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function recordTypeFromEnvelope(row: unknown): RecordType | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const name = typeof r["name"] === "string" ? r["name"] : null;
  const slug = typeof r["slug"] === "string" ? r["slug"] : null;
  if (!name || !slug) return null;
  return {
    name,
    slug,
    description:
      typeof r["description"] === "string" ? r["description"] : "",
    icon: typeof r["icon"] === "string" ? r["icon"] : null,
    fields: Array.isArray(r["fields"])
      ? (r["fields"] as RecordField[])
      : [],
    relationships: Array.isArray(r["relationships"])
      ? (r["relationships"] as RecordRelationship[])
      : [],
  };
}

function parseProvenance(
  raw: Record<string, unknown> | undefined,
): RecordProvenance {
  if (!raw)
    return {
      createdBy: "unknown",
      createdByUserId: null,
      confidence: 1,
      source: null,
      derivedFrom: [],
      createdAt: new Date(),
    };
  return {
    createdBy: String(raw["created_by"] ?? "unknown"),
    createdByUserId:
      typeof raw["created_by_user"] === "string"
        ? (raw["created_by_user"] as string)
        : null,
    confidence:
      typeof raw["confidence"] === "number" ? raw["confidence"] : 1,
    source: typeof raw["source"] === "string" ? raw["source"] : null,
    derivedFrom: Array.isArray(raw["derived_from"])
      ? (raw["derived_from"] as string[])
      : [],
    createdAt:
      typeof raw["created_at"] === "string"
        ? new Date(raw["created_at"])
        : new Date(),
  };
}

function parseRecord(
  recordType: string,
  row: Record<string, unknown>,
): GraphRecord {
  const provenance = parseProvenance(
    row["_provenance"] as Record<string, unknown> | undefined,
  );
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k.startsWith("_")) continue;
    data[k] = v;
  }
  return {
    id: String(row["id"] ?? ""),
    recordType,
    data,
    provenance,
  };
}

/**
 * SurrealDB implementation of the GraphProvider port. One SurrealDB
 * namespace per workspace (`ws_<slug>`); one database per collection
 * within it (`col_<workspace>_<collection>`). Every per-collection
 * call pins both via `surreal-ns` and `surreal-db` headers so a
 * connection-scope directive like `USE NS x DB y` cannot re-point
 * the session at another tenant's data — see t03 P0 #2 Layer 2.
 */
export class SurrealGraphProvider implements GraphProvider {
  readonly id = "surrealdb";

  constructor(private readonly client: SurrealClient) {}

  async provision(address: CollectionAddress): Promise<void> {
    // Per-workspace namespace bootstrap. DEFINE NAMESPACE IF NOT
    // EXISTS is idempotent — a workspace's second collection no-ops
    // the namespace creation and continues straight to DEFINE
    // DATABASE for the new collection. provision/deprovision are the
    // only paths that legitimately ship DDL — they opt in to
    // multi-statement bodies (Layer 3, t03 P0 #2).
    await this.client.sql(
      `DEFINE NAMESPACE IF NOT EXISTS ${address.namespace};`,
      null,
      { allowMultiStatement: true, ns: address.namespace },
    );
    await this.client.sql(
      `DEFINE DATABASE IF NOT EXISTS ${address.database};`,
      null,
      { allowMultiStatement: true, ns: address.namespace },
    );

    // Seed the record-type registry. Upserts on name so a re-provision
    // won't duplicate rows.
    const ddl: string[] = [
      `DEFINE TABLE IF NOT EXISTS _record_types SCHEMAFULL;`,
      `DEFINE FIELD IF NOT EXISTS name ON _record_types TYPE string;`,
      `DEFINE FIELD IF NOT EXISTS slug ON _record_types TYPE string;`,
      `DEFINE FIELD IF NOT EXISTS description ON _record_types TYPE string;`,
      `DEFINE FIELD IF NOT EXISTS icon ON _record_types TYPE option<string>;`,
      // SurrealDB v2 notes: `array` without element type drops inner
      // contents; `array<object>` alone strips un-declared keys because
      // the table is SCHEMAFULL. FLEXIBLE TYPE tells it to preserve
      // the object's raw keys verbatim, matching our shape
      // {name, type, required} / {name, targetType, edge}.
      `DEFINE FIELD IF NOT EXISTS fields ON _record_types FLEXIBLE TYPE array<object>;`,
      `DEFINE FIELD IF NOT EXISTS relationships ON _record_types FLEXIBLE TYPE array<object>;`,
      `DEFINE INDEX IF NOT EXISTS _record_types_slug_idx ON _record_types FIELDS slug UNIQUE;`,
    ];
    for (const seed of DEFAULT_RECORD_TYPES) {
      ddl.push(`DEFINE TABLE IF NOT EXISTS ${seed.slug} SCHEMALESS;`);
      // Use record-id form (_record_types:slug). UPSERT...WHERE in
      // SurrealDB v2 only applies its SET clause to existing rows —
      // newly-created rows end up with just the WHERE fields. Targeting
      // a known id sidesteps that and keeps provision idempotent.
      ddl.push(
        `UPSERT _record_types:${seed.slug} CONTENT { name: ${quote(seed.name)}, slug: ${quote(seed.slug)}, description: ${quote(seed.description)}, icon: ${seed.icon ? quote(seed.icon) : "NONE"}, fields: ${jsonify(seed.fields)}, relationships: ${jsonify(seed.relationships)} };`,
      );
    }
    await this.client.sql(ddl.join("\n"), address.database, {
      allowMultiStatement: true,
      ns: address.namespace,
    });
  }

  async deprovision(address: CollectionAddress): Promise<void> {
    try {
      await this.client.sql(
        `REMOVE DATABASE IF EXISTS ${address.database};`,
        null,
        { allowMultiStatement: true, ns: address.namespace },
      );
    } catch (err) {
      // Idempotent — we don't want deprovision-then-deprovision to throw.
      // But upstream errors (auth, network) still bubble.
      const code = (err as { code?: string })?.code;
      if (code === "graph_provider_unreachable") throw err;
      if (code === "graph_unauthorized") throw err;
    }
  }

  async query(input: QueryInput): Promise<QueryResult> {
    // Layer 1 (t03 P0 #2): refuse agent-controlled SurrealQL that
    // mutates the connection's namespace/db scope or the install's
    // schema. Without this, `USE DB <foreign>; SELECT ...` smuggled
    // through here re-points the connection at another workspace's
    // database before the SELECT runs. Layer 3 (in SurrealClient.sql)
    // is the structural backstop against future directives we
    // haven't enumerated. Layer 2 (per-request `ns` pin below) is the
    // tenancy isolation that contains a successful Layer 1 bypass.
    assertSafeAgentQuery(input.query);
    const body = await this.client.sql(input.query, input.collection.database, {
      ns: input.collection.namespace,
    });
    return { rows: body };
  }

  async write(input: WriteInput): Promise<GraphRecord> {
    const provenance = {
      created_by: `session:${input.provenance.sessionId}`,
      created_by_user: input.provenance.userId,
      confidence: input.provenance.confidence,
      source: input.provenance.source,
      derived_from: input.provenance.derivedFrom,
      created_at: new Date().toISOString(),
    };
    const data = { ...input.data, _provenance: provenance };
    const createSql = `CREATE ${input.recordType} CONTENT ${jsonify(data)};`;

    const body = (await this.client.sql(
      createSql,
      input.collection.database,
      { ns: input.collection.namespace },
    )) as SurrealResultEnvelope[];
    const row = unwrapSingle(body) as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | null;
    if (!row) throw new InvalidGraphQueryError("CREATE returned no row");

    const record = parseRecord(
      input.recordType,
      Array.isArray(row) ? (row[0] as Record<string, unknown>) : row,
    );

    // Auto-register the record type on FIRST observation only. Using
    // UPSERT here clobbered seed rows' name/description (seeded as
    // "Person"/"...") with the write's slug ("person"/"") on every
    // single write — breaking the UI's display name. INSERT...IGNORE
    // inserts only when the id doesn't exist, leaving seeded rows
    // alone.
    const fields = Object.keys(input.data)
      .filter((k) => !k.startsWith("_"))
      .map((name) => ({ name, type: "string", required: false }));
    const registerSql = `INSERT IGNORE INTO _record_types { id: _record_types:${input.recordType}, name: ${quote(input.recordType)}, slug: ${quote(input.recordType)}, description: '', icon: NONE, fields: ${jsonify(fields)}, relationships: [] };`;
    try {
      await this.client.sql(registerSql, input.collection.database, {
        ns: input.collection.namespace,
      });
    } catch {
      // Registration is best-effort; the write itself succeeded.
    }
    return record;
  }

  async relate(input: RelateInput): Promise<GraphEdge> {
    const props = jsonify(input.properties ?? {});
    const q = `RELATE ${input.from}->${input.edge}->${input.to} CONTENT ${props};`;
    const body = (await this.client.sql(q, input.collection.database, {
      ns: input.collection.namespace,
    })) as SurrealResultEnvelope[];
    const row = unwrapSingle(body);
    if (!row || typeof row !== "object")
      throw new InvalidGraphQueryError("RELATE returned no row");
    const obj = Array.isArray(row)
      ? (row[0] as Record<string, unknown>)
      : (row as Record<string, unknown>);
    return {
      id: String(obj["id"] ?? ""),
      from: String(obj["in"] ?? input.from),
      to: String(obj["out"] ?? input.to),
      edge: input.edge,
      properties: { ...input.properties },
    };
  }

  async resolve(input: ResolveInput): Promise<GraphRecord | null> {
    const wheres: string[] = [];
    if (input.email)
      wheres.push(`email = ${quote(input.email)}`);
    if (input.name) wheres.push(`name = ${quote(input.name)}`);
    for (const [k, v] of Object.entries(input.attributes ?? {})) {
      if (typeof v === "string") wheres.push(`${k} = ${quote(v)}`);
      else wheres.push(`${k} = ${jsonify(v)}`);
    }
    if (wheres.length === 0) return null;
    const q = `SELECT * FROM ${input.recordType} WHERE ${wheres.join(" OR ")} LIMIT 1;`;
    const body = (await this.client.sql(q, input.collection.database, {
      ns: input.collection.namespace,
    })) as SurrealResultEnvelope[];
    const rows = unwrapSingle(body);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return parseRecord(
      input.recordType,
      rows[0] as Record<string, unknown>,
    );
  }

  async discover(
    address: CollectionAddress,
  ): Promise<readonly RecordType[]> {
    const body = (await this.client.sql(
      `SELECT * FROM _record_types ORDER BY slug;`,
      address.database,
      { ns: address.namespace },
    )) as SurrealResultEnvelope[];
    const rows = unwrapSingle(body);
    if (!Array.isArray(rows)) {
      throw new CollectionNotProvisionedError(address.database);
    }
    return rows
      .map(recordTypeFromEnvelope)
      .filter((x): x is RecordType => x !== null);
  }
}
