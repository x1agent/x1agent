// Domain
export * from "./domain/message.js";

// Ports
export type {
  MessagingProvider,
  PostMessageInput,
} from "./ports/messaging-provider.js";

// Contract tests — consumed by adapter test files.
export {
  runMessagingProviderContract,
  type MessagingProviderContractFixture,
} from "./contract-tests/messaging-provider.contract.js";

// Fakes
export * from "./application/fakes.js";
