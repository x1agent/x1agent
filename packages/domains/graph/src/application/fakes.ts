import {
  CollectionAlreadyProvisionedError,
  CollectionNotProvisionedError,
} from "../domain/errors.js";
import {
  DEFAULT_RECORD_TYPES,
  type RecordType,
} from "../domain/record-type.js";
import type {
  GraphEdge,
  GraphRecord,
  RecordProvenance,
} from "../domain/record.js";
import type { CollectionHandle } from "../domain/collection-handle.js";
import type {
  GraphProvider,
  QueryInput,
  QueryResult,
  RelateInput,
  ResolveInput,
  WriteInput,
} from "../ports/graph-provider.js";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}:fake_${idCounter.toString(16).padStart(8, "0")}`;
}

interface CollectionState {
  records: GraphRecord[];
  edges: GraphEdge[];
  recordTypes: Map<string, RecordType>;
}

function buildProvenance(input: WriteInput): RecordProvenance {
  return {
    createdBy: `session:${input.provenance.sessionId}`,
    createdByUserId: input.provenance.userId,
    confidence: input.provenance.confidence,
    source: input.provenance.source,
    derivedFrom: input.provenance.derivedFrom,
    createdAt: new Date(),
  };
}

/**
 * In-memory graph provider for tests. Holds records in arrays; `query`
 * returns a naive JSON snapshot of the matching table (the fake does
 * not parse real SurrealQL). Good enough to drive the application layer
 * and the sidecar through its paces; real-engine semantics are proven
 * by the SurrealDB contract tests.
 */
export class InMemoryGraphProvider implements GraphProvider {
  readonly id = "fake";
  readonly collections = new Map<CollectionHandle, CollectionState>();

  async provision(handle: CollectionHandle): Promise<void> {
    if (this.collections.has(handle))
      throw new CollectionAlreadyProvisionedError(handle);
    this.collections.set(handle, {
      records: [],
      edges: [],
      recordTypes: new Map(
        DEFAULT_RECORD_TYPES.map((r) => [r.slug, r] as const),
      ),
    });
  }

  async deprovision(handle: CollectionHandle): Promise<void> {
    this.collections.delete(handle);
  }

  private state(handle: CollectionHandle): CollectionState {
    const s = this.collections.get(handle);
    if (!s) throw new CollectionNotProvisionedError(handle);
    return s;
  }

  async query(input: QueryInput): Promise<QueryResult> {
    const s = this.state(input.collection);
    // The fake has no query engine. It returns the lot — enough to let
    // callers prove they can shape a request and handle a response.
    return { rows: s.records };
  }

  async write(input: WriteInput): Promise<GraphRecord> {
    const s = this.state(input.collection);
    const record: GraphRecord = {
      id: nextId(input.recordType),
      recordType: input.recordType,
      data: { ...input.data },
      provenance: buildProvenance(input),
    };
    s.records.push(record);
    if (!s.recordTypes.has(input.recordType)) {
      s.recordTypes.set(input.recordType, {
        name: input.recordType,
        slug: input.recordType,
        description: "",
        icon: null,
        fields: Object.keys(input.data)
          .filter((k) => !k.startsWith("_"))
          .map((name) => ({ name, type: "string", required: false })),
        relationships: [],
      });
    }
    return record;
  }

  async relate(input: RelateInput): Promise<GraphEdge> {
    const s = this.state(input.collection);
    const edge: GraphEdge = {
      id: nextId("edge"),
      from: input.from,
      to: input.to,
      edge: input.edge,
      properties: { ...input.properties },
    };
    s.edges.push(edge);
    return edge;
  }

  async resolve(input: ResolveInput): Promise<GraphRecord | null> {
    const s = this.state(input.collection);
    return (
      s.records.find((r) => {
        if (r.recordType !== input.recordType) return false;
        if (input.email && r.data["email"] === input.email) return true;
        if (input.name && r.data["name"] === input.name) return true;
        for (const [k, v] of Object.entries(input.attributes ?? {})) {
          if (r.data[k] === v) return true;
        }
        return false;
      }) ?? null
    );
  }

  async discover(handle: CollectionHandle): Promise<readonly RecordType[]> {
    const s = this.state(handle);
    return Array.from(s.recordTypes.values()).sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
  }
}
