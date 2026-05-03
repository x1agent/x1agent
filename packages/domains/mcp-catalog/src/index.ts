// Domain
export { CatalogName } from "./domain/catalog-name.js";
export type { CatalogEntry } from "./domain/catalog-entry.js";
export type {
  Manifest,
  EnvDeclaration,
  EnvKind,
} from "./domain/manifest.js";
export { validateManifest } from "./domain/manifest.js";
export type { Attachment, AttachmentEnvValue } from "./domain/attachment.js";

// Ports
export type {
  CatalogRepository,
  CatalogUpsertInput,
} from "./ports/catalog-repository.js";
export type {
  AttachmentRepository,
  AttachmentUpsertInput,
} from "./ports/attachment-repository.js";

// Application
export { CatalogService } from "./application/catalog-service.js";
export type { CatalogSetInput } from "./application/catalog-service.js";
export { AttachmentService } from "./application/attachment-service.js";
export type { AttachInput } from "./application/attachment-service.js";

// OAuth helpers
export {
  discoverMcpServer,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
  type DiscoveryResult,
} from "./application/oauth-discovery.js";
export {
  registerOAuthClient,
  type RegisterClientInput,
  type RegisteredClient,
} from "./application/oauth-dcr.js";
export {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  type PkcePair,
  type TokenResponse,
} from "./application/oauth-flow.js";
export type {
  OAuthClientRepository,
  OAuthClientRecord,
  EncryptedOAuthClientBlob,
} from "./ports/oauth-client-repository.js";
export type {
  UserTokenRepository,
  EncryptedUserTokenInput,
  EncryptedTokenBlob,
  DecryptedUserTokenBlob,
} from "./ports/user-token-repository.js";
export type { UserMcpToken, UserMcpTokenPlain } from "./domain/user-token.js";
export {
  UserTokenService,
  type StartFlowInput,
  type StartFlowResult,
  type CompleteFlowInput,
  type OAuthFlowState,
  type UserTokenServiceDeps,
} from "./application/user-token-service.js";
export type { RemoteOAuthDeps } from "./application/catalog-service.js";

// Adapters
export { PostgresCatalogRepository } from "./adapters/postgres/postgres-catalog-repository.js";
export { PostgresAttachmentRepository } from "./adapters/postgres/postgres-attachment-repository.js";
export { PostgresOAuthClientRepository } from "./adapters/postgres/postgres-oauth-client-repository.js";
export { PostgresUserTokenRepository } from "./adapters/postgres/postgres-user-token-repository.js";
export {
  createMcpOAuthRoutes,
  createMcpUserTokenRoutes,
  type OAuthRoutesConfig,
} from "./adapters/hono/oauth-routes.js";
export {
  createMcpCatalogRoutes,
  createAgentMcpAttachmentRoutes,
} from "./adapters/hono/routes.js";
export type {
  CatalogRoutesConfig,
  AttachmentRoutesConfig,
} from "./adapters/hono/routes.js";
