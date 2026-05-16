// Domain
export * from "./domain/workspace.js";
export * from "./domain/workspace-settings.js";
export * from "./domain/membership.js";
export * from "./domain/group.js";
export * from "./domain/access-grant.js";

// Ports
export type { WorkspaceRepository } from "./ports/workspace-repository.js";
export type { MembershipRepository } from "./ports/membership-repository.js";
export type {
  GroupRepository,
  CreateGroupInput,
} from "./ports/group-repository.js";
export type {
  AccessGrantRepository,
  CreateAccessGrantInput,
} from "./ports/access-grant-repository.js";

// Application
export * from "./application/assert-role-for-slug.js";
export * from "./application/create-workspace.js";
export * from "./application/update-workspace-settings.js";

// Adapters
export { PostgresWorkspaceRepository } from "./adapters/postgres/postgres-workspace-repository.js";
export { PostgresMembershipRepository } from "./adapters/postgres/postgres-membership-repository.js";
export { PostgresGroupRepository } from "./adapters/postgres/postgres-group-repository.js";
export { PostgresAccessGrantRepository } from "./adapters/postgres/postgres-access-grant-repository.js";
export { createWorkspaceRoutes } from "./adapters/hono/routes.js";
export { createGroupRoutes } from "./adapters/hono/group-routes.js";
export type { GroupRoutesConfig } from "./adapters/hono/group-routes.js";
export {
  createAccessGrantsRoutes,
  type AccessGrantsRoutesConfig,
} from "./adapters/hono/access-grants-routes.js";

// In-memory fakes (exported so tests in other packages can compose)
export * from "./application/fakes.js";
