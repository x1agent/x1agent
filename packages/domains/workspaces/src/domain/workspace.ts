import type { WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import type { WorkspaceSettings } from "./workspace-settings.js";

export interface Workspace {
  id: WorkspaceId;
  slug: WorkspaceSlug;
  name: string;
  createdAt: Date;
  /**
   * Per-workspace policy toggles. Always populated — the repository
   * applies safe defaults when a row was created before a setting
   * existed. See `workspace-settings.ts`.
   */
  settings: WorkspaceSettings;
}
