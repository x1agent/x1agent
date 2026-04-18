// Domain
export * from "./domain/workspace.js";
export * from "./domain/membership.js";

// Ports
export type { WorkspaceRepository } from "./ports/workspace-repository.js";
export type { MembershipRepository } from "./ports/membership-repository.js";

// Application
export * from "./application/assert-role-for-slug.js";

// Adapters
export { PostgresWorkspaceRepository } from "./adapters/postgres/postgres-workspace-repository.js";
export { PostgresMembershipRepository } from "./adapters/postgres/postgres-membership-repository.js";

// In-memory fakes (exported so tests in other packages can compose)
export * from "./application/fakes.js";
