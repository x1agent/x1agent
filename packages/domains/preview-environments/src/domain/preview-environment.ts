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
  /**
   * Workspace-scoped env-binding names this environment opts into.
   * Resolved at preview-deploy time against `env_bindings` (scope='workspace')
   * → `workspace_secrets`; the resolved values are injected into the
   * preview pod via a per-preview K8s Secret bundle. Empty by default.
   */
  envVarNames: string[];
  /**
   * Additional public hostnames the preview should answer on, beyond
   * its default `<slug>.<preview-domain>`. Bare hostnames only —
   * validated against RFC 1123 at the application layer. The provider
   * materializes one TLS entry + Ingress rule per alias on the next
   * deploy; cert-manager mints per-alias certs via ingress-shim.
   *
   * The operator owns the DNS for each alias and is expected to CNAME
   * it at the cluster's ingress hostname/IP before adding it here.
   */
  aliasHosts: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * RFC 1123 hostname check. Used at the application layer when adding
 * an alias; we reject early so a bad value can't reach the provider
 * (where it would fail Kubernetes' DNS-1123 validation deeper in the
 * stack with a less actionable error).
 *
 * Rules: lowercase, 1–253 chars total, labels 1–63 chars each, labels
 * start + end with alphanumeric, may contain hyphens internally, at
 * least one dot (single-label hostnames like `localhost` aren't valid
 * targets for public CNAMEs).
 */
const HOSTNAME_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidAliasHost(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => HOSTNAME_LABEL_RE.test(l));
}

export class InvalidAliasHostError extends DomainError {
  readonly code = "invalid_alias_host";
  constructor(public readonly raw: string) {
    super(
      `alias host ${JSON.stringify(raw)} must be a valid RFC 1123 hostname (lowercase, ≥1 dot, labels 1–63 chars)`,
    );
    this.name = "InvalidAliasHostError";
  }
}
