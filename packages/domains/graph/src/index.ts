// Domain
export * from "./domain/collection-handle.js";
export * from "./domain/errors.js";
export * from "./domain/record.js";
export * from "./domain/record-type.js";

// Ports
export type {
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

// Fakes
export * from "./application/fakes.js";
