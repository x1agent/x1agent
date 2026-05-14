import type { CollectionAddress } from "@x1agent/domain-graph";
import type { CollectionProviderType } from "../domain/collection.js";

/**
 * Narrow port the collections application layer uses to ask a provider
 * to provision/deprovision storage. Backed in dev and prod by a NATS
 * client in the api that publishes to `x1.provider.<domain>.provision`.
 * Tests pass a fake.
 *
 * Both graph and vector domains may need calls for a single collection
 * — SurrealDB-backed collections use a single provision call that
 * creates both the db and the vector index, but a split-provider setup
 * (graph=surrealdb, vector=turbopuffer) would fan out. The gateway
 * hides that.
 */
export interface ProviderGateway {
  /**
   * `settings` is the collection's settings jsonb passed through
   * verbatim. Adapters look at `settings.vector.dimension` /
   * `settings.vector.metric` to size the vector index, etc. An empty
   * object means "use provider defaults".
   */
  provision(
    providerType: CollectionProviderType,
    address: CollectionAddress,
    settings: Record<string, unknown>,
  ): Promise<void>;

  deprovision(
    providerType: CollectionProviderType,
    address: CollectionAddress,
  ): Promise<void>;

  /**
   * Return the record-type registry for a provisioned collection.
   * Powers the "Record types" card on the collection detail page and
   * any tool that wants to pick a record_type before writing.
   */
  discover(
    providerType: CollectionProviderType,
    address: CollectionAddress,
  ): Promise<readonly ProviderRecordType[]>;

  /**
   * Return every record of the named type, newest-first, capped at
   * `limit`. Powers the record-browser UI; agents get the same data
   * through graph_query.
   */
  listRecords(
    providerType: CollectionProviderType,
    address: CollectionAddress,
    recordType: string,
    limit: number,
  ): Promise<readonly ProviderRecord[]>;
}

/** Provider-opaque record shape — mirrors @x1agent/domain-graph's GraphRecord. */
export interface ProviderRecord {
  id: string;
  recordType: string;
  data: Record<string, unknown>;
  provenance: {
    createdBy: string;
    createdByUserId: string | null;
    confidence: number;
    source: string | null;
    derivedFrom: readonly string[];
    createdAt: string;
  };
}

/**
 * Mirror of @x1agent/domain-graph's RecordType, redeclared locally so
 * domain-collections doesn't force every caller to pull in the graph
 * package just for a response shape.
 */
export interface ProviderRecordType {
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  fields: ReadonlyArray<{ name: string; type: string; required: boolean }>;
  relationships: ReadonlyArray<{
    name: string;
    targetType: string;
    edge: string;
  }>;
}
