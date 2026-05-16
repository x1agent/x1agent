import type { WorkspaceId } from "@x1agent/kernel";
import {
  PreviewSlug,
  type PreviewEnvironment,
  type PreviewEnvironmentId,
} from "../domain/preview-environment.js";
import {
  PreviewEnvironmentNotFoundError,
  PreviewEnvironmentNotInWorkspaceError,
} from "../domain/errors.js";
import type { PreviewEnvironmentRepository } from "../ports/preview-environment-repository.js";

export interface GetPreviewEnvironmentDeps {
  repository: PreviewEnvironmentRepository;
}

/**
 * Lookup by id, scoped to a workspace. Cross-tenant id passes throw
 * PreviewEnvironmentNotInWorkspaceError (mapped to 404 at the API
 * boundary — see CLAUDE.md tenant isolation).
 */
export async function getPreviewEnvironmentById(
  deps: GetPreviewEnvironmentDeps,
  workspaceId: WorkspaceId,
  id: PreviewEnvironmentId,
): Promise<PreviewEnvironment> {
  const row = await deps.repository.findById(id);
  if (!row) {
    throw new PreviewEnvironmentNotFoundError({ id });
  }
  if (row.workspaceId !== workspaceId) {
    throw new PreviewEnvironmentNotInWorkspaceError(id, workspaceId);
  }
  return row;
}

/**
 * Lookup by slug within a workspace. Slugs are workspace-scoped by
 * design, so there's no cross-tenant ambiguity to defend against — a
 * missing row is just NotFound.
 */
export async function getPreviewEnvironmentBySlug(
  deps: GetPreviewEnvironmentDeps,
  workspaceId: WorkspaceId,
  slug: string,
): Promise<PreviewEnvironment> {
  const parsed = PreviewSlug(slug);
  const row = await deps.repository.findBySlug(workspaceId, parsed);
  if (!row) {
    throw new PreviewEnvironmentNotFoundError({ slug: parsed });
  }
  return row;
}
