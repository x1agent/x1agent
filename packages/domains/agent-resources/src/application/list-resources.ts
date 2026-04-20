import type { WorkspaceId } from "@x1agent/kernel";
import type { SharedResource } from "../domain/shared-resource.js";
import type { SharedResourceRepository } from "../ports/shared-resource-repository.js";

/**
 * List every shared resource installed in a workspace. Used by the
 * Settings UI, the job-watcher (to decide which credentials to mint per
 * session), and the branch reaper.
 */
export async function listWorkspaceResources(
  repo: SharedResourceRepository,
  workspaceId: WorkspaceId,
): Promise<readonly SharedResource[]> {
  return repo.listByWorkspace(workspaceId);
}
