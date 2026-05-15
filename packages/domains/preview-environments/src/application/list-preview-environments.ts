import type { WorkspaceId } from "@x1agent/kernel";
import type { PreviewEnvironment } from "../domain/preview-environment.js";
import type { PreviewEnvironmentRepository } from "../ports/preview-environment-repository.js";

export interface ListPreviewEnvironmentsDeps {
  repository: PreviewEnvironmentRepository;
}

export async function listPreviewEnvironments(
  deps: ListPreviewEnvironmentsDeps,
  workspaceId: WorkspaceId,
): Promise<PreviewEnvironment[]> {
  return deps.repository.listForWorkspace(workspaceId);
}
