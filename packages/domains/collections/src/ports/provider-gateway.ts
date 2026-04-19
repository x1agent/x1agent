import type { CollectionHandle } from "@x1agent/domain-graph";
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
  provision(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
  ): Promise<void>;

  deprovision(
    providerType: CollectionProviderType,
    handle: CollectionHandle,
  ): Promise<void>;
}
