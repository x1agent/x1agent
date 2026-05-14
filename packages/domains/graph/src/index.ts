// Domain
export * from "./domain/collection-handle.js";
export * from "./domain/workspace-namespace.js";
export * from "./domain/errors.js";
export * from "./domain/record.js";
export * from "./domain/record-type.js";

// Ports
export type {
  CollectionAddress,
  GraphProvider,
  QueryInput,
  QueryResult,
  RelateInput,
  ResolveInput,
  WriteInput,
} from "./ports/graph-provider.js";

// Contract tests
export {
  runGraphProviderContract,
  type GraphProviderContractFixture,
} from "./contract-tests/graph-provider.contract.js";

// Adapters
export {
  SurrealClient,
  type SurrealClientConfig,
} from "./adapters/surrealdb/surreal-client.js";
export { SurrealGraphProvider } from "./adapters/surrealdb/surreal-graph-provider.js";

// Fakes
export * from "./application/fakes.js";
