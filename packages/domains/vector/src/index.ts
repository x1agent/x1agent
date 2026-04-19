// Domain
export * from "./domain/namespace.js";
export * from "./domain/errors.js";

// Ports
export type {
  VectorProvider,
  ProvisionInput,
  UpsertInput,
  SearchInput,
  SearchHit,
  SearchResult,
} from "./ports/vector-provider.js";

// Contract tests
export {
  runVectorProviderContract,
  type VectorProviderContractFixture,
} from "./contract-tests/vector-provider.contract.js";

// Fakes
export * from "./application/fakes.js";
