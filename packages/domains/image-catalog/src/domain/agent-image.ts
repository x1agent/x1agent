import type { DockerfileSource } from "./dockerfile-source.js";
import type { ImageName } from "./image-name.js";
import type { ImageStatus } from "./image-status.js";

/**
 * One row in `agent_images`. Either a platform preset
 * (`workspaceId === null`, `isPreset === true`) or a workspace-authored
 * image (`workspaceId !== null`, `isPreset === false`).
 *
 * `builtRef` is digest-pinned for workspace images
 * (`<reg>/ws/<wsid>/<name>@sha256:<digest>`). Presets are tag-pinned at
 * build time by repo CI. Pod-spec uses `builtRef` verbatim.
 */
export interface AgentImage {
  id: string;
  workspaceId: string | null;
  name: ImageName;
  displayName: string;
  description: string | null;
  builtRef: string;
  isPreset: boolean;
  dockerfileSource: DockerfileSource | "";
  buildStatus: ImageStatus;
  buildLog: string;
  lastBuiltAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sourceKind?: "preset" | "workspace_build" | "external_oci";
  requestedRef?: string | null;
  resolvedDigestRef?: string | null;
  createdBy?: string | null;
}
