// Domain
export * from "./domain/collection.js";

// Ports
export type {
  CollectionRepository,
  CreateCollectionInput,
  UpdateCollectionInput,
  AttachInput,
} from "./ports/collection-repository.js";
export type { ProviderGateway } from "./ports/provider-gateway.js";
export type { AdminGuard } from "./ports/admin-guard.js";

// Application
export * from "./application/create-collection.js";
export * from "./application/delete-collection.js";
export * from "./application/update-collection.js";
export * from "./application/list-collections.js";
export * from "./application/sync-agent-attachments.js";

// Adapters
export { PostgresCollectionRepository } from "./adapters/postgres/postgres-collection-repository.js";

// Fakes
export * from "./application/fakes.js";
