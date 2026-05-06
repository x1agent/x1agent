import type {
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { Workspace } from "../domain/workspace.js";
import type { WorkspaceSettings } from "../domain/workspace-settings.js";

export interface WorkspaceRepository {
  findById(id: WorkspaceId): Promise<Workspace | null>;
  findBySlug(slug: WorkspaceSlug): Promise<Workspace | null>;

  create(input: {
    slug: WorkspaceSlug;
    name: string;
  }): Promise<Workspace>;

  /**
   * Atomic merge: read existing settings, overlay the patch, write
   * back. Throws WorkspaceNotFoundError-equivalent (returns null) if
   * the workspace doesn't exist. Returns the post-merge entity so
   * callers don't need a follow-up read.
   */
  updateSettings(
    id: WorkspaceId,
    patch: Partial<WorkspaceSettings>,
  ): Promise<Workspace | null>;
}
