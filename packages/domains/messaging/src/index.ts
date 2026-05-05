// Domain
export * from "./domain/message.js";
export * from "./domain/slack-bot-config.js";
export * from "./domain/slack-install.js";

// Ports
export type {
  MessagingProvider,
  PostMessageInput,
} from "./ports/messaging-provider.js";
export type { SlackBotConfigStore } from "./ports/slack-bot-config-store.js";
export type { SlackInstallStore } from "./ports/slack-install-store.js";
export type { SlackInstallStateStore } from "./ports/slack-install-state-store.js";
export type { AgentWorkspaceReader } from "./ports/agent-workspace-reader.js";
export type { SlackInstallCompleter } from "./ports/slack-install-completer.js";
export type {
  SlackConnectedChannel,
  SlackConnectedChannelStore,
} from "./ports/slack-connected-channel-store.js";
export type {
  SlackOAuthClient,
  SlackOAuthExchangeResult,
} from "./ports/slack-oauth-client.js";
export { SlackOAuthExchangeError } from "./ports/slack-oauth-client.js";
export type { SlackManifestBuilder } from "./ports/slack-manifest-builder.js";

// Application use cases
export {
  createSlackBotConfig,
  type CreateSlackBotConfigDeps,
  type CreateSlackBotConfigInput,
  type CreateSlackBotConfigResult,
} from "./application/create-slack-bot-config.js";
export {
  recordSlackInstall,
  type RecordSlackInstallDeps,
  type RecordSlackInstallInput,
  type RecordSlackInstallResult,
} from "./application/record-slack-install.js";
export {
  pairSlackBot,
  unpairSlackBot,
  type PairSlackBotDeps,
} from "./application/pair-slack-bot.js";
export {
  verifySlackEventSignature,
  type VerifySlackEventSignatureDeps,
  type VerifySlackEventSignatureInput,
} from "./application/verify-slack-event-signature.js";

// Contract tests — consumed by adapter test files.
export {
  runMessagingProviderContract,
  type MessagingProviderContractFixture,
} from "./contract-tests/messaging-provider.contract.js";

// Adapters
export {
  SlackMessagingProvider,
  type SlackMessagingProviderConfig,
} from "./adapters/slack/slack-messaging-provider.js";
export {
  SlackOAuthHttpClient,
  type SlackOAuthHttpClientConfig,
} from "./adapters/slack/slack-oauth-http-client.js";
export {
  SlackManifestUrlBuilder,
  type SlackManifestUrlBuilderConfig,
} from "./adapters/slack/slack-manifest-url-builder.js";
export { PostgresSlackBotConfigStore } from "./adapters/postgres/postgres-slack-bot-config-store.js";
export {
  PostgresSlackInstallStore,
  type SlackTokenCipher,
} from "./adapters/postgres/postgres-slack-install-store.js";
export { PostgresSlackInstallStateStore } from "./adapters/postgres/postgres-slack-install-state-store.js";
export { PostgresSlackConnectedChannelStore } from "./adapters/postgres/postgres-slack-connected-channel-store.js";
export { PostgresAgentWorkspaceReader } from "./adapters/postgres/postgres-agent-workspace-reader.js";
export { PostgresSlackInstallCompleter } from "./adapters/postgres/postgres-slack-install-completer.js";
export {
  SlackHttpReplyClient,
  SlackReplyError,
  type SlackReplyClient,
  type SlackReplyFailureKind,
  type SlackReplyInput,
  type SlackHttpReplyClientConfig,
} from "./adapters/slack/slack-reply-client.js";
export {
  createSlackOAuthRoutes,
  createSlackBotApiRoutes,
  type SlackRoutesConfig,
} from "./adapters/hono/slack-routes.js";
export {
  createSlackEventsRoutes,
  type SlackEventsRoutesConfig,
  type AppMentionContext,
  type DirectMessageContext,
  type ChannelMembershipContext,
  type BotResolution,
} from "./adapters/hono/slack-events-routes.js";

// Fakes
export * from "./application/fakes.js";
export * from "./application/slack-fakes.js";
