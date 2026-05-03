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

// Adapters
export { PostgresCatalogRepository } from "./adapters/postgres/postgres-catalog-repository.js";
export { PostgresAttachmentRepository } from "./adapters/postgres/postgres-attachment-repository.js";
export {
  createMcpCatalogRoutes,
  createAgentMcpAttachmentRoutes,
} from "./adapters/hono/routes.js";
export type {
  CatalogRoutesConfig,
  AttachmentRoutesConfig,
} from "./adapters/hono/routes.js";
