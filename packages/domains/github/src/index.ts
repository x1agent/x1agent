// Domain
export * from "./domain/installation.js";
export * from "./domain/repo.js";

// Ports
export type { GitHubAppClient, GitHubInstallationInfo } from "./ports/github-app-client.js";
export type { InstallationRepository } from "./ports/installation-repository.js";
export type { AgentRepoStore } from "./ports/agent-repo-store.js";

// Application
export * from "./application/record-installation.js";
export * from "./application/attach-repo-to-agent.js";
export * from "./application/detach-repo-from-agent.js";

// Adapters
export { OctokitGitHubAppClient } from "./adapters/octokit/octokit-github-app-client.js";
export { PostgresInstallationRepository } from "./adapters/postgres/postgres-installation-repository.js";
export { PostgresAgentRepoStore } from "./adapters/postgres/postgres-agent-repo-store.js";
export {
  createGitHubInstallRoutes,
  createInstallationApiRoutes,
  createAgentRepoRoutes,
  InMemoryInstallStateStore,
  type InstallStateStore,
  type GitHubRoutesConfig,
} from "./adapters/hono/routes.js";

// Fakes
export * from "./application/fakes.js";
