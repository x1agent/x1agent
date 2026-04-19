/**
 * A record is one entity in a collection — instance of a RecordType.
 * The shape is deliberately open: SurrealDB is schemaless, Neo4j nodes
 * have open properties, agent-authored records routinely extend the
 * declared field set. Provenance lives in `_provenance`, never at the
 * top level.
 */
export interface GraphRecord {
  /** Provider-native id — SurrealDB returns `table:hash`, Neo4j `123`. */
  id: string;
  recordType: string;
  /** Agent-supplied payload. Does not include provenance. */
  data: Record<string, unknown>;
  /** Who wrote this record, when, at what confidence. */
  provenance: RecordProvenance;
}

export interface RecordProvenance {
  /** `session:<uuid>` — the session that wrote the row. */
  createdBy: string;
  /** user id on that session, if user-driven. */
  createdByUserId: string | null;
  /** 0..1. The agent's self-reported confidence in the fact. */
  confidence: number;
  /** Free-form source — URL, doc id, "manual", etc. Optional. */
  source: string | null;
  /**
   * Ids of other records this one was derived from. Enables
   * "undo everything that came out of that meeting note".
   */
  derivedFrom: readonly string[];
  createdAt: Date;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  edge: string;
  properties: Record<string, unknown>;
}
