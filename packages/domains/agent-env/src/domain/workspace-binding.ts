import type { EnvName } from "./env-name.js";

/**
 * Workspace-scoped env-var binding. Same shape as AgentEnvBinding (the
 * underlying env_bindings row is identical) but the owner is the
 * workspace, not a specific agent.
 *
 * Use case: an operator binds DATABASE_URL once at the workspace level
 * against a workspace_secret. Multiple consumers — agent sessions,
 * preview environments — opt into the same binding by name, so the
 * value lives in exactly one place and rotates atomically.
 */
export interface WorkspaceEnvBinding {
  id: string;
  workspaceId: string;
  envName: EnvName;
  /** Workspace secret name. The bare reference, NOT `${...}`-wrapped. */
  secretName: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}
