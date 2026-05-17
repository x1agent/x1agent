// Domain
export * from "./domain/session.js";
export * from "./domain/status.js";
export * from "./domain/trigger.js";
export * from "./domain/event.js";
export * from "./domain/session-history.js";
export * from "./domain/share.js";
export * from "./domain/share-comment.js";

// Ports
export type {
  SessionRepository,
  CreateSessionInput,
  UpdateSessionStatusInput,
} from "./ports/session-repository.js";
export type {
  ShareCommentRepository,
  AppendShareCommentInput,
  ThreadLocator,
} from "./ports/share-comment-repository.js";
export type {
  ShareCommentPublisher,
  ShareCommentAddedEvent,
  ShareCommentThreadResolvedEvent,
} from "./ports/share-comment-publisher.js";
export type {
  SessionEventRepository,
  AppendSessionEventInput,
} from "./ports/session-event-repository.js";
export type {
  TokenUsageRepository,
  RecordTokenUsageInput,
} from "./ports/token-usage-repository.js";
export type { AdminGuard } from "./ports/admin-guard.js";
export type { PlatformAdminGuard } from "./ports/platform-admin-guard.js";
export type { MessageInjector } from "./ports/message-injector.js";
export type {
  SessionShareRepository,
  CreateSessionShareInput,
} from "./ports/session-share-repository.js";
export type { SessionSummarizer } from "./ports/session-summarizer.js";
export { StubSessionSummarizer } from "./ports/session-summarizer.js";

// Application
export * from "./application/trigger-session.js";
export * from "./application/list-sessions.js";
export * from "./application/cancel-session.js";
export * from "./application/cancel-child-session.js";
export * from "./application/delete-sessions.js";
export * from "./application/schedule-due-sessions.js";
export * from "./application/next-due.js";
export * from "./application/append-session-event.js";
export * from "./application/list-session-events.js";
export * from "./application/spawn-child-session.js";
export * from "./application/resume-session.js";
export * from "./application/reconcile-session-status.js";
export * from "./application/manage-session-shares.js";
export {
  resolveSessionVisibility,
  pickSessionListMode,
  type SessionVisibilityReason,
  type SessionVisibilityResult,
  type SessionVisibilityDeps,
  type SessionListMode,
  type PickSessionListModeDeps,
} from "./application/session-visibility.js";
export {
  maybeUpdateSessionSummary,
  DEFAULT_SUMMARY_CONFIG,
  type MaybeUpdateSessionSummaryConfig,
  type MaybeUpdateSessionSummaryDeps,
  type MaybeUpdateSessionSummaryInput,
  type MaybeUpdateSessionSummaryResult,
} from "./application/maybe-update-session-summary.js";

// Adapters
export { PostgresSessionRepository } from "./adapters/postgres/postgres-session-repository.js";
export { PostgresSessionEventRepository } from "./adapters/postgres/postgres-session-event-repository.js";
export {
  PostgresTokenUsageRepository,
  tierDefaultPrices,
  type PriceOverride,
} from "./adapters/postgres/postgres-token-usage-repository.js";
export { PostgresSessionShareRepository } from "./adapters/postgres/postgres-session-share-repository.js";
export { PostgresShareCommentRepository } from "./adapters/postgres/postgres-share-comment-repository.js";
export {
  NatsShareCommentPublisher,
  RecordingShareCommentPublisher,
  SUBJECT_COMMENT_ADDED,
  SUBJECT_THREAD_RESOLVED,
  type NatsPublishPort,
} from "./adapters/nats/nats-share-comment-publisher.js";
export {
  AnthropicSessionSummarizer,
  type AnthropicSessionSummarizerOptions,
} from "./adapters/anthropic/anthropic-session-summarizer.js";
export {
  VertexAnthropicSessionSummarizer,
  type VertexAnthropicSessionSummarizerOptions,
} from "./adapters/anthropic/vertex-anthropic-session-summarizer.js";
export {
  OpenAISessionSummarizer,
  type OpenAISessionSummarizerOptions,
} from "./adapters/openai/openai-session-summarizer.js";
export {
  createSessionRoutes,
  createWorkspaceSessionRoutes,
} from "./adapters/hono/routes.js";
export { createSessionShareRoutes } from "./adapters/hono/share-routes.js";
export type { SessionShareRoutesConfig } from "./adapters/hono/share-routes.js";
export {
  createShareCommentRoutes,
  createInternalShareCommentRoutes,
} from "./adapters/hono/share-comment-routes.js";
export type {
  ShareCommentRoutesConfig,
  InternalShareCommentRoutesConfig,
} from "./adapters/hono/share-comment-routes.js";
export {
  postShareComment,
  type PostShareCommentInput,
  type PostShareCommentDeps,
  type PostShareCommentResult,
} from "./application/post-share-comment.js";
export {
  resolveShareThread,
  resolveShare,
  type ResolveShareThreadDeps,
  type ResolveShareThreadResult,
  type ResolveShareDeps,
} from "./application/resolve-share-thread.js";
// `resolveSessionVisibility` + `SessionVisibilityResult` are NOT re-exported
// from share-visibility.js — they intentionally shadow the X1A-9 primitive
// in `./application/session-visibility.js` with a temporary inline shape
// (`{ok}|{error}` vs `{visible,reason}`). Callers inside the sessions
// package that need the share-comment-routes shape import directly from
// `../../application/share-visibility.js`. Package consumers always get
// the X1A-9 primitive via the session-visibility.js re-export above.
export {
  findShareInSession,
  type ShareVisibilityDeps,
  type FindShareInSessionDeps,
} from "./application/share-visibility.js";
export { createWorkspaceTokenUsageRoutes } from "./adapters/hono/token-usage-routes.js";
export { createWorkspaceCostRoutes } from "./adapters/hono/cost-routes.js";
export type { CostRoutesConfig } from "./adapters/hono/cost-routes.js";
export type {
  AgentCostWindow,
  AgentSessionCost,
  AgentTokenUsageRollup,
  SessionTokenUsageRollup,
  SessionTreeChildCost,
  SessionTreeRollup,
  TokenUsageByDay,
  TokenUsageByModel,
  TokenUsageTotals,
} from "./ports/token-usage-repository.js";

// Fakes
export * from "./application/fakes.js";
