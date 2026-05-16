import type { WorkspaceId } from "@x1agent/kernel";
import {
  PreviewSlug,
  type DeployStatus,
  type PreviewEnvironment,
} from "../domain/preview-environment.js";
import type { PreviewEnvironmentRepository } from "../ports/preview-environment-repository.js";

/**
 * Called by the api at two points in the preview-deploy flow:
 *
 *   1. Before publishing the NATS request — `status: 'provisioning'`,
 *      url/image/sha unknown. The row appears in the UI immediately
 *      so the operator sees the deploy is happening, not waiting for
 *      the Kaniko build to finish.
 *   2. After the NATS reply lands — `status: 'ready' | 'failed'` with
 *      the final url/image/sha (or the failure reason).
 *
 * Idempotent on (workspaceId, slug) — same row each time. The slug is
 * the routing key in the URL and stays stable for the life of the row;
 * the title only gets set on first INSERT so an admin's rename in the
 * UI isn't clobbered by a later deploy.
 *
 * Throws PreviewSlugTakenError when a different repo claims a slug
 * that's already owned by another repo in the same workspace.
 */
export interface UpsertPreviewEnvironmentDeps {
  repository: PreviewEnvironmentRepository;
}

export interface UpsertPreviewEnvironmentCommand {
  workspaceId: WorkspaceId;
  slug: string;
  repoFullName: string;
  branch: string;
  deploy: {
    status: DeployStatus;
    sha?: string | null;
    url?: string | null;
    imageRef?: string | null;
    statusReason?: string | null;
  };
}

export async function upsertPreviewEnvironment(
  deps: UpsertPreviewEnvironmentDeps,
  cmd: UpsertPreviewEnvironmentCommand,
): Promise<PreviewEnvironment> {
  const slug = PreviewSlug(cmd.slug);
  return deps.repository.upsert({
    workspaceId: cmd.workspaceId,
    slug,
    // The initial title is just the slug. Admin renames live on the row
    // afterwards; the repository's upsert only writes `title` on INSERT.
    initialTitle: cmd.slug,
    repoFullName: cmd.repoFullName,
    branch: cmd.branch,
    deploy: {
      status: cmd.deploy.status,
      sha: cmd.deploy.sha ?? null,
      url: cmd.deploy.url ?? null,
      imageRef: cmd.deploy.imageRef ?? null,
      statusReason: cmd.deploy.statusReason ?? null,
      at: cmd.deploy.status === "provisioning" ? null : new Date(),
    },
  });
}
