import { DomainError } from "@x1agent/kernel";
import type { WorkspaceId } from "@x1agent/kernel";
import type { PreviewEnvironmentId, PreviewSlug } from "./preview-environment.js";

export class PreviewEnvironmentNotFoundError extends DomainError {
  readonly code = "preview_environment_not_found";
  constructor(
    public readonly ref: { id: PreviewEnvironmentId } | { slug: PreviewSlug },
  ) {
    super(`preview environment ${JSON.stringify(ref)} not found`);
    this.name = "PreviewEnvironmentNotFoundError";
  }
}

/**
 * The environment exists but lives in a different workspace than the
 * caller. Surfaced as 404 (not 403) at the API boundary to avoid
 * leaking cross-tenant existence — the caller learns nothing about
 * other workspaces. See CLAUDE.md "Workspace tenant isolation".
 */
export class PreviewEnvironmentNotInWorkspaceError extends DomainError {
  readonly code = "preview_environment_not_in_workspace";
  constructor(
    public readonly id: PreviewEnvironmentId,
    public readonly workspaceId: WorkspaceId,
  ) {
    super(
      `preview environment ${id} does not belong to workspace ${workspaceId}`,
    );
    this.name = "PreviewEnvironmentNotInWorkspaceError";
  }
}

/**
 * Two different repos in the same workspace tried to claim the same
 * slug. Operator picks a different slug or rotates one of the repos'
 * `.x1agent/preview.yaml` metadata.name.
 */
export class PreviewSlugTakenError extends DomainError {
  readonly code = "preview_slug_taken";
  constructor(
    public readonly workspaceId: WorkspaceId,
    public readonly slug: PreviewSlug,
    public readonly existingRepo: string,
  ) {
    super(
      `slug ${slug} in workspace ${workspaceId} is already used by ${existingRepo}`,
    );
    this.name = "PreviewSlugTakenError";
  }
}
