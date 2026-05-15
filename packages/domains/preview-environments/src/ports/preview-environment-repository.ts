import type { WorkspaceId } from "@x1agent/kernel";
import type {
  DeployStatus,
  PreviewEnvironment,
  PreviewEnvironmentId,
  PreviewSlug,
} from "../domain/preview-environment.js";

/**
 * Input for the upsert path. The provider call is the only caller — it
 * carries (workspace, slug, repo, branch) and the deploy result. The
 * application layer picks INSERT vs UPDATE; this port is pure persistence.
 */
export interface UpsertPreviewEnvironmentInput {
  workspaceId: WorkspaceId;
  slug: PreviewSlug;
  /**
   * Operator-facing label. On INSERT this becomes the row's title; on
   * UPDATE we leave the title alone so an admin's rename in the UI
   * doesn't get clobbered by the next deploy.
   */
  initialTitle: string;
  repoFullName: string;
  branch: string;
  /**
   * The deploy result. `status: pending` is what a fresh row starts
   * with on the very first call before the provider's NATS reply
   * lands; the same call updates again to `ready` or `failed` once
   * the provider returns. The provider's flow already maps onto these.
   */
  deploy: {
    status: DeployStatus;
    sha: string | null;
    url: string | null;
    imageRef: string | null;
    statusReason: string | null;
    at: Date | null;
  };
}

export interface PreviewEnvironmentRepository {
  /**
   * INSERT or UPDATE keyed by (workspace_id, slug). Returns the row
   * after the write. Implementations are responsible for the ON
   * CONFLICT path so callers see a consistent post-write state.
   *
   * Throws PreviewSlugTakenError when a different (repo) tries to
   * claim a slug already owned by another repo in the same workspace.
   */
  upsert(input: UpsertPreviewEnvironmentInput): Promise<PreviewEnvironment>;

  findById(id: PreviewEnvironmentId): Promise<PreviewEnvironment | null>;

  findBySlug(
    workspaceId: WorkspaceId,
    slug: PreviewSlug,
  ): Promise<PreviewEnvironment | null>;

  /**
   * List every environment in a workspace, most-recently-deployed first.
   * No paging in v1 — workspaces with > 100 environments are an
   * outlier and can wait for a later slice.
   */
  listForWorkspace(workspaceId: WorkspaceId): Promise<PreviewEnvironment[]>;

  /**
   * Admin-only rename. Does NOT touch the slug — that's the URL routing
   * key and stays stable for the life of the environment.
   */
  rename(
    id: PreviewEnvironmentId,
    workspaceId: WorkspaceId,
    title: string,
  ): Promise<PreviewEnvironment>;

  /**
   * Hard delete. The application layer is responsible for the cluster
   * teardown (Deployment / Service / Ingress); this just removes the
   * row.
   */
  delete(id: PreviewEnvironmentId, workspaceId: WorkspaceId): Promise<void>;
}
