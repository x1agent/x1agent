// Domain
export * from "./domain/workspace.js";
export * from "./domain/membership.js";
export * from "./domain/group.js";

// Ports
export type { WorkspaceRepository } from "./ports/workspace-repository.js";
export type { MembershipRepository } from "./ports/membership-repository.js";
export type {
  GroupRepository,
  CreateGroupInput,
} from "./ports/group-repository.js";

// Application
export * from "./application/assert-role-for-slug.js";
export * from "./application/create-workspace.js";

// Adapters
export { PostgresWorkspaceRepository } from "./adapters/postgres/postgres-workspace-repository.js";
export { PostgresMembershipRepository } from "./adapters/postgres/postgres-membership-repository.js";
export { PostgresGroupRepository } from "./adapters/postgres/postgres-group-repository.js";
export { createWorkspaceRoutes } from "./adapters/hono/routes.js";

// In-memory fakes (exported so tests in other packages can compose)
export * from "./application/fakes.js";
