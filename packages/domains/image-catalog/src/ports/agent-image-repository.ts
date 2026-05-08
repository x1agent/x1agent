import type { AgentImage } from "../domain/agent-image.js";
import type { DockerfileSource } from "../domain/dockerfile-source.js";
import type { ImageName } from "../domain/image-name.js";
import type { ImageStatus } from "../domain/image-status.js";

export interface CreateImageInput {
  workspaceId: string;
  name: ImageName;
  displayName: string;
  description: string | null;
  dockerfileSource: DockerfileSource;
  /** Initial built_ref. For new workspace images this is empty until the
   * first build succeeds; the column is NOT NULL so we store '' as the
   * sentinel. The repository surfaces this as '' in the entity. */
  builtRef: string;
  buildStatus: ImageStatus;
}

export interface UpdateImageInput {
  workspaceId: string;
  id: string;
  displayName?: string;
  description?: string | null;
  dockerfileSource?: DockerfileSource;
  buildStatus?: ImageStatus;
  /** Set when transitioning to succeeded. */
  builtRef?: string;
  /** Set on failure; cleared on success. */
  buildLog?: string;
  /** Set when transitioning to succeeded. */
  lastBuiltAt?: Date;
}

/**
 * Read + write boundary for `agent_images`. Workspace presets
 * (workspace_id IS NULL) are read-only via this port; mutations are
 * scoped to a single workspace.
 */
export interface AgentImageRepository {
  /** Workspace images + every platform preset, sorted preset-first. */
  list(workspaceId: string): Promise<AgentImage[]>;

  /** Single image, scoped to the workspace OR globally if it's a preset. */
  getVisible(workspaceId: string, id: string): Promise<AgentImage | null>;

  /** Workspace-scoped lookup by name; used to enforce uniqueness pre-insert. */
  findByName(
    workspaceId: string,
    name: ImageName,
  ): Promise<AgentImage | null>;

  create(input: CreateImageInput): Promise<AgentImage>;

  /** Partial update. Returns null if no row matched (id + workspace_id + is_preset=false). */
  update(input: UpdateImageInput): Promise<AgentImage | null>;

  /** Delete a workspace image. Returns false if no row matched or the row was a preset. */
  delete(workspaceId: string, id: string): Promise<boolean>;
}
