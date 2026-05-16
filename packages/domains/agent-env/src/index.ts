// Domain
export { EnvName } from "./domain/env-name.js";
export type { AgentEnvBinding } from "./domain/binding.js";
export type { WorkspaceEnvBinding } from "./domain/workspace-binding.js";

// Ports
export type {
  BindingRepository,
  BindingUpsertInput,
} from "./ports/binding-repository.js";
export type {
  WorkspaceBindingRepository,
  WorkspaceBindingUpsertInput,
} from "./ports/workspace-binding-repository.js";

// Application
export { BindingService } from "./application/binding-service.js";
export type {
  BindingSetInput,
  SecretExistsCheck,
} from "./application/binding-service.js";
export { WorkspaceBindingService } from "./application/workspace-binding-service.js";
export type { WorkspaceBindingSetInput } from "./application/workspace-binding-service.js";

// Adapters
export { PostgresBindingRepository } from "./adapters/postgres/postgres-binding-repository.js";
export { PostgresWorkspaceBindingRepository } from "./adapters/postgres/postgres-workspace-binding-repository.js";
export { createAgentEnvRoutes } from "./adapters/hono/routes.js";
export type { AgentEnvRoutesConfig } from "./adapters/hono/routes.js";
export { createWorkspaceEnvRoutes } from "./adapters/hono/workspace-routes.js";
export type { WorkspaceEnvRoutesConfig } from "./adapters/hono/workspace-routes.js";
