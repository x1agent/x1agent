import { DomainError, ValidationError } from "@x1agent/kernel";
import type { WorkspaceId } from "@x1agent/kernel";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare const previewEnvironmentIdBrand: unique symbol;
export type PreviewEnvironmentId = string & {
  readonly [previewEnvironmentIdBrand]: true;
};
export const PreviewEnvironmentId = (raw: string): PreviewEnvironmentId => {
  if (!UUID_RE.test(raw)) {
    throw new ValidationError("preview_environment_id", "must be a UUID");
  }
  return raw.toLowerCase() as PreviewEnvironmentId;
};

/**
 * The slug a preview environment is addressed by inside its workspace.
 * Comes from `.x1agent/preview.yaml` metadata.name; must satisfy the
 * K8s DNS-1123 label shape because the provider uses it as the
 * Service / Ingress / Deployment name and as a host label.
 */
declare const previewSlugBrand: unique symbol;
export type PreviewSlug = string & { readonly [previewSlugBrand]: true };

const PREVIEW_SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/;

export const PreviewSlug = (raw: string): PreviewSlug => {
  if (!PREVIEW_SLUG_RE.test(raw)) {
    throw new InvalidPreviewSlugError(raw);
  }
  return raw as PreviewSlug;
};

export class InvalidPreviewSlugError extends DomainError {
  readonly code = "invalid_preview_slug";
  constructor(public readonly raw: string) {
    super(
      `slug ${JSON.stringify(raw)} must match /^[a-z][a-z0-9-]{0,62}$/ (K8s DNS-1123 label)`,
    );
    this.name = "InvalidPreviewSlugError";
  }
}

export type DeployStatus =
  | "pending"
  | "provisioning"
  | "ready"
  | "failed";

const DEPLOY_STATUSES = new Set<DeployStatus>([
  "pending",
  "provisioning",
  "ready",
  "failed",
]);

export const isDeployStatus = (raw: string): raw is DeployStatus =>
  DEPLOY_STATUSES.has(raw as DeployStatus);

/**
 * A durable preview slot in a workspace. Successive `preview_deploy`
 * calls for the same (workspace, slug) update the same row in place
 * — the slug is the routing key in the URL, the row is the slot.
 *
 * `lastDeploy*` fields hold the most recent attempt; older deploys
 * are not tracked in v1 (history table is a future add).
 */
export interface PreviewEnvironment {
  id: PreviewEnvironmentId;
  workspaceId: WorkspaceId;
  slug: PreviewSlug;
  title: string;
  repoFullName: string;
  branch: string;
  lastDeploySha: string | null;
  lastDeployUrl: string | null;
  lastDeployImageRef: string | null;
  lastDeployStatus: DeployStatus;
  lastDeployStatusReason: string | null;
  lastDeployAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
