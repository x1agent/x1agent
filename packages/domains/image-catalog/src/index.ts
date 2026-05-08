// Domain
export type { AgentImage } from "./domain/agent-image.js";
export { ImageName } from "./domain/image-name.js";
export {
  DockerfileSource,
  dockerfileHash,
} from "./domain/dockerfile-source.js";
export {
  type ImageStatus,
  SELECTABLE_STATUSES,
  isSelectable,
  isTerminal,
} from "./domain/image-status.js";
export {
  ImageNotFoundError,
  ImageNameTakenError,
  CannotMutatePresetError,
  ImageInUseError,
} from "./domain/errors.js";

// Ports
export type {
  AgentImageRepository,
  CreateImageInput,
  UpdateImageInput,
} from "./ports/agent-image-repository.js";
export type { BuildQueue } from "./ports/build-queue.js";
export type { AgentImageUsageReader } from "./ports/agent-image-usage-reader.js";

// Application
export {
  ImageCatalogService,
  type CreateInput,
  type UpdateInput,
} from "./application/image-catalog-service.js";

// Adapters
export { PostgresAgentImageRepository } from "./adapters/postgres/postgres-agent-image-repository.js";
export {
  NoopBuildQueue,
  NatsBuildQueue,
  type NatsClientLike,
} from "./adapters/nats/nats-build-queue.js";
