// Domain
export * from "./domain/session.js";
export * from "./domain/status.js";
export * from "./domain/trigger.js";
export * from "./domain/event.js";
export * from "./domain/session-history.js";
export * from "./domain/share.js";

// Ports
export type {
  SessionRepository,
  CreateSessionInput,
  UpdateSessionStatusInput,
} from "./ports/session-repository.js";
export type {
  SessionEventRepository,
  AppendSessionEventInput,
} from "./ports/session-event-repository.js";
export type {
  TokenUsageRepository,
  RecordTokenUsageInput,
} from "./ports/token-usage-repository.js";
export type { AdminGuard } from "./ports/admin-guard.js";
export type { MessageInjector } from "./ports/message-injector.js";
export type {
  SessionShareRepository,
  CreateSessionShareInput,
} from "./ports/session-share-repository.js";

// Application
export * from "./application/trigger-session.js";
export * from "./application/list-sessions.js";
export * from "./application/cancel-session.js";
export * from "./application/schedule-due-sessions.js";
export * from "./application/next-due.js";
export * from "./application/append-session-event.js";
export * from "./application/list-session-events.js";
export * from "./application/spawn-child-session.js";
export * from "./application/resume-session.js";
export * from "./application/reconcile-session-status.js";
export * from "./application/manage-session-shares.js";

// Adapters
export { PostgresSessionRepository } from "./adapters/postgres/postgres-session-repository.js";
export { PostgresSessionEventRepository } from "./adapters/postgres/postgres-session-event-repository.js";
export { PostgresTokenUsageRepository } from "./adapters/postgres/postgres-token-usage-repository.js";
export { PostgresSessionShareRepository } from "./adapters/postgres/postgres-session-share-repository.js";
export {
  createSessionRoutes,
  createWorkspaceSessionRoutes,
} from "./adapters/hono/routes.js";
export { createSessionShareRoutes } from "./adapters/hono/share-routes.js";
export type { SessionShareRoutesConfig } from "./adapters/hono/share-routes.js";
export { createWorkspaceTokenUsageRoutes } from "./adapters/hono/token-usage-routes.js";

// Fakes
export * from "./application/fakes.js";
