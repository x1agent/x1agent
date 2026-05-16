import * as k8s from "@kubernetes/client-node";

/**
 * Persistence + rollout port for platform LLM keys. Implementations
 * write the key under a known K8s Secret the api Deployment envFroms,
 * then trigger a rolling restart so the new pods pick up the value.
 *
 * Storage shape (X1A-46 v1):
 *
 *   - Secret/x1agent-platform-secrets (NOT managed by ESO; owned by api)
 *     is the source of truth for admin-edited values.
 *   - The api Deployment envFroms BOTH x1agent-secrets (ESO-synced from
 *     the cloud secret store) AND x1agent-platform-secrets, with the
 *     platform-secrets listed second so its keys shadow the ESO copy
 *     when present. Clearing a key removes it from platform-secrets
 *     entirely, restoring whatever value the ESO copy may carry.
 *
 * The status endpoint never goes through this port — it reads
 * process.env directly so the boolean reflects the LIVE api pod's view,
 * not whatever's been written to the K8s Secret pending the next
 * rollout. That avoids advertising "configured" while old pods are
 * still serving the old key.
 */
export interface PlatformSecretsStore {
  /** Upsert `name=value` into the platform-secrets Secret. */
  setKey(name: string, value: string): Promise<void>;
  /** Remove `name` from the platform-secrets Secret if present. */
  clearKey(name: string): Promise<void>;
  /**
   * Trigger a rolling restart of the api Deployment so new pods pick up
   * the latest envFrom snapshot. Called after setKey/clearKey by the
   * routes layer so the UI's "API will restart in ~30s" toast tells
   * the truth.
   */
  rolloutRestartApi(): Promise<void>;
}

export interface K8sPlatformSecretsStoreConfig {
  kubeConfig: k8s.KubeConfig;
  /** Namespace the api Deployment + Secret live in. */
  namespace: string;
  /** Secret name the api Deployment envFroms for admin-edited keys. */
  secretName: string;
  /** Deployment name to roll on save/clear. Defaults to "api". */
  deploymentName?: string;
  /** Now-source — overridable for tests. */
  now?: () => Date;
}

/**
 * Real implementation backed by the Kubernetes API. Writes to a Secret
 * (creates on first use) and patches the api Deployment's pod template
 * with a kubectl-style restartedAt annotation, which is the canonical
 * way to trigger a rollout without changing image tags.
 */
export class K8sPlatformSecretsStore implements PlatformSecretsStore {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly namespace: string;
  private readonly secretName: string;
  private readonly deploymentName: string;
  private readonly now: () => Date;

  constructor(cfg: K8sPlatformSecretsStoreConfig) {
    this.core = cfg.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.apps = cfg.kubeConfig.makeApiClient(k8s.AppsV1Api);
    this.namespace = cfg.namespace;
    this.secretName = cfg.secretName;
    this.deploymentName = cfg.deploymentName ?? "api";
    this.now = cfg.now ?? (() => new Date());
  }

  async setKey(name: string, value: string): Promise<void> {
    const data: Record<string, string> = {};
    data[name] = Buffer.from(value, "utf8").toString("base64");
    await this.upsertSecret(data);
  }

  async clearKey(name: string): Promise<void> {
    // JSON-merge patch with `null` removes the key from data — kube's
    // strategic-merge-patch on Secret treats data as a regular map.
    // We use a strategic-merge body shaped { data: { name: null } }.
    try {
      await this.core.patchNamespacedSecret(
        {
          name: this.secretName,
          namespace: this.namespace,
          body: { data: { [name]: null } } as unknown as k8s.V1Secret,
        },
        k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch),
      );
    } catch (err) {
      // 404: Secret doesn't exist yet — nothing to clear. Treat as a
      // no-op so the UI's Clear button is idempotent on a fresh
      // install where no key has ever been written.
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async rolloutRestartApi(): Promise<void> {
    const restartedAt = this.now().toISOString();
    // Strategic-merge-patch the deployment's pod template with a
    // kubectl.kubernetes.io/restartedAt annotation. This is what
    // `kubectl rollout restart deploy/api` does under the hood — every
    // pod gets a new templateHash, triggering a rolling replace.
    // @kubernetes/client-node 1.x requires the Content-Type header to
    // be set explicitly; without it the API server tries to decode
    // the body as a RFC 6902 JSON Patch array and rejects with 400.
    await this.apps.patchNamespacedDeployment(
      {
        name: this.deploymentName,
        namespace: this.namespace,
        body: {
          spec: {
            template: {
              metadata: {
                annotations: {
                  "kubectl.kubernetes.io/restartedAt": restartedAt,
                },
              },
            },
          },
        } as unknown as k8s.V1Deployment,
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch),
    );
  }

  private async upsertSecret(data: Record<string, string>): Promise<void> {
    try {
      await this.core.patchNamespacedSecret(
        {
          name: this.secretName,
          namespace: this.namespace,
          body: { data } as unknown as k8s.V1Secret,
        },
        k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch),
      );
    } catch (err) {
      if (isNotFound(err)) {
        // Helm installs an empty Secret of this name on first chart
        // upgrade, so this branch only fires on dev installs that ran
        // an older chart. Create the Secret on the fly and retry once.
        await this.core.createNamespacedSecret({
          namespace: this.namespace,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
              name: this.secretName,
              labels: { "app.kubernetes.io/managed-by": "x1agent-api" },
            },
            type: "Opaque",
            data,
          },
        });
        return;
      }
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number; response?: { statusCode?: number } };
  return e.code === 404 || e.response?.statusCode === 404;
}

/**
 * No-op store used when the api is not running in a cluster (e.g.
 * `bun run packages/api/src/index.ts` against a local Postgres without
 * devspace). Routes return a clear 503 instead of silently no-oping —
 * see PlatformSecretsRoutes for the gate.
 */
export class NoopPlatformSecretsStore implements PlatformSecretsStore {
  // eslint-disable-next-line @typescript-eslint/require-await
  async setKey(): Promise<void> {
    throw new PlatformSecretsUnavailableError();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async clearKey(): Promise<void> {
    throw new PlatformSecretsUnavailableError();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async rolloutRestartApi(): Promise<void> {
    throw new PlatformSecretsUnavailableError();
  }
}

export class PlatformSecretsUnavailableError extends Error {
  readonly code = "platform_secrets_unavailable" as const;
  constructor() {
    super(
      "kube_config_unavailable: platform secret writes require an in-cluster api pod",
    );
  }
}
