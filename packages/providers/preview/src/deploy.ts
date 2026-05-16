import * as k8s from "@kubernetes/client-node";
import {
  buildDeployment,
  buildIngress,
  buildKanikoJob,
  buildService,
} from "./manifests.js";
import { parsePreviewSpec, PreviewSpecError } from "./preview-spec.js";

/**
 * One-shot deploy path. Called by the NATS provision handler once
 * per request. Returns the public URL when the preview is reachable,
 * or throws with a structured reason.
 *
 * Steps:
 *   1. Parse + validate the preview.yaml content.
 *   2. Mint a short-lived GitHub App installation token (via the
 *      api's internal git-credential endpoint).
 *   3. Create a Kaniko Job that clones the branch, builds the
 *      Dockerfile, pushes to the in-cluster registry.
 *   4. Wait for the Job to succeed (or fail fast).
 *   5. Apply Deployment + Service + Ingress. Replace if they
 *      already exist (redeploy is a normal flow for branch updates).
 *   6. Wait for the Deployment to be ready.
 *   7. Return the URL.
 *
 * No in-memory caching or state; every call is independent. Idempotent
 * on the same (slug, sha) tuple — the Kaniko image tag is the sha, so
 * a redeploy with the same sha skips the push step by letting Kaniko
 * overwrite the same tag.
 */

export interface DeployInputs {
  /** The raw yaml string of .x1agent/preview.yaml. */
  previewYaml: string;
  /** owner/repo, e.g. 'hirer-co/app'. */
  repoFullName: string;
  /** Branch the caller wants deployed. */
  branch: string;
  /** Specific commit sha; used as the image tag and in git checkout. */
  commitSha: string;
  /** GitHub App installation id for minting the clone token. */
  installationId: number;
  /** Registry host:port reachable from inside the cluster. */
  registryAddress: string;
  /** Whether that registry is HTTP (Kaniko needs --insecure). */
  registryInsecure: boolean;
  /** Namespace the Kaniko Job runs in. */
  buildNamespace: string;
  /**
   * Optional KSA the Kaniko Pod runs as. Required for Artifact Registry
   * pushes (KSA must be Workload-Identity-bound to a writer GSA).
   */
  buildServiceAccount?: string;
  /** Namespace the Deployment / Service / Ingress go into. */
  previewNamespace: string;
  /** The domain pattern; slug fills the subdomain (e.g. 'preview.local.x1agent.dev'). */
  previewDomain: string;
  /** Wildcard TLS secret name in the preview namespace. */
  tlsSecretName: string;
  /** URL of the x1agent api (cluster-internal). Used to mint installation tokens. */
  apiUrl: string;
  /** Shared secret for `/api/internal/*`. */
  apiInternalToken: string;
  /**
   * Pre-resolved workspace secret values keyed by their workspace
   * secret name. The api side resolves these (Zone 2 for previews —
   * see docs/security/agent-env.md) and forwards plaintext over NATS;
   * the preview provider mints a per-preview K8s Secret with stringData
   * and the Deployment references it via valueFrom.secretKeyRef.
   *
   * Empty/undefined when the spec uses no `from: secret:<NAME>` env vars.
   */
  secretValues?: Record<string, string>;
  /**
   * Workspace env-binding overrides keyed by env-var name. Merged with
   * spec.env entries — extraEnv wins on a name collision because it's
   * the operator's explicit per-environment override. Values land in
   * the same per-preview K8s Secret as secretValues; the Deployment
   * env block references the Secret via valueFrom.secretKeyRef.
   */
  extraEnv?: Record<string, string>;
}

export interface DeployResult {
  url: string;
  slug: string;
  image: string;
  jobName: string;
}

export class DeployError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TeardownInputs {
  slug: string;
  previewNamespace: string;
}

export interface TeardownResult {
  slug: string;
  /** Names of K8s resources deleted (best-effort; missing items skipped). */
  deleted: string[];
}

/**
 * Inverse of deployPreview — removes the per-preview Deployment,
 * Service, Ingress, and Secret bundle from `previewNamespace`. Used
 * by the workspace UI's "Delete environment" button (routed via NATS
 * from the api).
 *
 * Idempotent: missing resources are skipped without raising. Errors
 * other than 404 surface as DeployError("teardown_failed", …) so the
 * caller can decide whether to retry or surface to the operator.
 */
export async function teardownPreview(
  kc: k8s.KubeConfig,
  inputs: TeardownInputs,
): Promise<TeardownResult> {
  const clients = makeClients(kc);
  const deleted: string[] = [];

  const tryDelete = async (
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await fn();
      deleted.push(name);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404 || code === undefined) return;
      throw new DeployError("teardown_failed", `${name}: ${(err as Error).message}`);
    }
  };

  await tryDelete(`ingress/${inputs.slug}`, () =>
    clients.networking.deleteNamespacedIngress({
      name: inputs.slug,
      namespace: inputs.previewNamespace,
    }),
  );
  await tryDelete(`service/${inputs.slug}`, () =>
    clients.core.deleteNamespacedService({
      name: inputs.slug,
      namespace: inputs.previewNamespace,
    }),
  );
  await tryDelete(`deployment/${inputs.slug}`, () =>
    clients.apps.deleteNamespacedDeployment({
      name: inputs.slug,
      namespace: inputs.previewNamespace,
    }),
  );
  const secretName = `preview-secrets-${inputs.slug}`.slice(0, 63);
  await tryDelete(`secret/${secretName}`, () =>
    clients.core.deleteNamespacedSecret({
      name: secretName,
      namespace: inputs.previewNamespace,
    }),
  );

  return { slug: inputs.slug, deleted };
}

/**
 * Ask the api to mint a GitHub App installation token. Returns
 * `{ username, password }` where password is `ghs_xxx`. Throws
 * DeployError on non-200.
 */
export async function mintInstallationToken(
  apiUrl: string,
  apiInternalToken: string,
  installationId: number,
): Promise<{ username: string; token: string }> {
  const res = await fetch(
    `${apiUrl}/api/internal/git-credential?installation_id=${installationId}`,
    { headers: { "X-Internal-Token": apiInternalToken } },
  );
  if (!res.ok) {
    throw new DeployError(
      "token_mint_failed",
      `api returned ${res.status} minting token for installation ${installationId}`,
    );
  }
  const body = (await res.json()) as { username: string; token: string };
  return body;
}

/**
 * Construct the destination image reference. The tag is the commit
 * sha so redeploys are idempotent — same sha, same image.
 */
export function imageRefFor(
  registry: string,
  slug: string,
  sha: string,
): string {
  const shortSha = sha.slice(0, 12);
  return `${registry}/previews/${slug}:${shortSha}`;
}

/**
 * Slugify + truncate to fit the K8s DNS-1123 label limit. Kaniko
 * Job names get a `preview-build-` prefix and a short sha suffix;
 * Deployment / Service / Ingress get the spec's slug directly.
 */
export function kanikoJobName(slug: string, sha: string): string {
  const shortSha = sha.slice(0, 8);
  return `preview-build-${slug}-${shortSha}`.slice(0, 63);
}

export interface K8sClients {
  batch: k8s.BatchV1Api;
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
  networking: k8s.NetworkingV1Api;
}

export function makeClients(kc: k8s.KubeConfig): K8sClients {
  return {
    batch: kc.makeApiClient(k8s.BatchV1Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
  };
}

/**
 * Poll a Job until it Completes or Fails. Times out if it exceeds
 * the Job's activeDeadlineSeconds (or a local hard cap). Returns
 * 'complete' | 'failed'.
 */
export async function waitForJob(
  clients: K8sClients,
  name: string,
  namespace: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<"complete" | "failed"> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await clients.batch.readNamespacedJobStatus({
      name,
      namespace,
    });
    const status = res.status;
    if (status?.succeeded && status.succeeded > 0) return "complete";
    if (status?.failed && status.failed > 0) return "failed";
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new DeployError(
    "job_timeout",
    `Job ${name} did not reach a terminal status within ${timeoutMs / 1000}s`,
  );
}

/**
 * Apply a manifest via create-or-replace. The preview namespace's
 * RBAC permits delete+create; there's no need for Server-Side Apply
 * here, and the "replace everything" approach keeps the manifest
 * history simple (one revision per deploy).
 */
async function applyOrReplace<T>(
  name: string,
  create: () => Promise<T>,
  replace: () => Promise<T>,
): Promise<void> {
  try {
    await create();
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 409) throw err;
    await replace();
  }
  void name;
}

/**
 * Poll a Deployment until it has >=1 ready replica. Times out if
 * it doesn't become ready.
 */
export async function waitForDeploymentReady(
  clients: K8sClients,
  name: string,
  namespace: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await clients.apps.readNamespacedDeploymentStatus({
      name,
      namespace,
    });
    if ((res.status?.readyReplicas ?? 0) >= 1) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new DeployError(
    "deployment_not_ready",
    `Deployment ${name} did not become ready within ${timeoutMs / 1000}s`,
  );
}

export async function deployPreview(
  kc: k8s.KubeConfig,
  inputs: DeployInputs,
): Promise<DeployResult> {
  let spec;
  try {
    spec = parsePreviewSpec(inputs.previewYaml);
  } catch (err) {
    if (err instanceof PreviewSpecError) {
      throw new DeployError("invalid_preview_spec", err.message);
    }
    throw err;
  }

  const slug = spec.metadata.name;
  const image = imageRefFor(inputs.registryAddress, slug, inputs.commitSha);
  const jobName = kanikoJobName(slug, inputs.commitSha);
  const host = `${slug}.${inputs.previewDomain}`;
  const selfUrl = `https://${host}`;

  const clients = makeClients(kc);

  // Step 1: build
  const { token } = await mintInstallationToken(
    inputs.apiUrl,
    inputs.apiInternalToken,
    inputs.installationId,
  );
  const kanikoJob = buildKanikoJob({
    jobName,
    namespace: inputs.buildNamespace,
    gitUrl: `https://github.com/${inputs.repoFullName}.git`,
    gitRef: inputs.commitSha,
    dockerfilePath: spec.spec.entrypoint.path,
    buildContext: spec.spec.entrypoint.buildContext,
    destination: image,
    insecureRegistry: inputs.registryInsecure,
    accessToken: token,
    serviceAccountName: inputs.buildServiceAccount,
  });
  try {
    await clients.batch.createNamespacedJob({
      namespace: inputs.buildNamespace,
      body: kanikoJob,
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 409) {
      throw new DeployError(
        "kaniko_create_failed",
        (err as Error).message,
      );
    }
    // Existing Job with same name and sha — let it finish.
  }

  const jobStatus = await waitForJob(clients, jobName, inputs.buildNamespace);
  if (jobStatus === "failed") {
    throw new DeployError(
      "kaniko_build_failed",
      `Kaniko Job ${jobName} failed — inspect pod logs in ${inputs.buildNamespace}`,
    );
  }

  // Step 2a: mint per-preview secret bundle. Two sources feed in:
  //   - spec `from: secret:<NAME>` entries get the workspace secret
  //     value (keyed by secret name).
  //   - extraEnv (workspace env-bindings the env opted into) gets the
  //     env-var value (keyed by env-var name). extraEnv collisions
  //     win since they're the explicit per-environment override.
  // Both go into the same K8s Secret stringData; the manifest builder
  // emits both via valueFrom.secretKeyRef with the appropriate key.
  let secretBundleName: string | undefined;
  const referencedSecrets = new Set<string>();
  for (const e of spec.spec.env) {
    if (e.from && e.from.startsWith("secret:")) {
      referencedSecrets.add(e.from.slice("secret:".length));
    }
  }
  const extraEnv = inputs.extraEnv ?? {};
  const hasExtraEnv = Object.keys(extraEnv).length > 0;
  if ((referencedSecrets.size > 0 && inputs.secretValues) || hasExtraEnv) {
    secretBundleName = `preview-secrets-${slug}`.slice(0, 63);
    const stringData: Record<string, string> = {};
    if (inputs.secretValues) {
      for (const name of referencedSecrets) {
        const value = inputs.secretValues[name];
        if (typeof value === "string") {
          stringData[name] = value;
        }
        // Missing values are skipped silently — the manifest builder
        // emits empty string in their place, surfacing as a "missing
        // env" error in the user's app, not as a deploy crash.
      }
    }
    for (const [envName, value] of Object.entries(extraEnv)) {
      stringData[envName] = value;
    }
    if (Object.keys(stringData).length > 0) {
      const secretBody: k8s.V1Secret = {
        metadata: {
          name: secretBundleName,
          namespace: inputs.previewNamespace,
          labels: {
            app: slug,
            "x1-preview": "true",
            "x1-component": "preview-secrets",
          },
        },
        type: "Opaque",
        stringData,
      };
      await applyOrReplace(
        slug,
        () =>
          clients.core.createNamespacedSecret({
            namespace: inputs.previewNamespace,
            body: secretBody,
          }),
        () =>
          clients.core.replaceNamespacedSecret({
            name: secretBundleName!,
            namespace: inputs.previewNamespace,
            body: secretBody,
          }),
      );
    } else {
      secretBundleName = undefined;
    }
  }

  // Step 2: apply Deployment / Service / Ingress
  const deployInputs = {
    slug,
    namespace: inputs.previewNamespace,
    image,
    spec,
    host,
    tlsSecretName: inputs.tlsSecretName,
    selfUrl,
    secretBundleName,
    extraEnv,
  };
  const deployment = buildDeployment(deployInputs);
  const service = buildService(deployInputs);
  const ingress = buildIngress(deployInputs);

  await applyOrReplace(
    slug,
    () =>
      clients.apps.createNamespacedDeployment({
        namespace: inputs.previewNamespace,
        body: deployment,
      }),
    () =>
      clients.apps.replaceNamespacedDeployment({
        name: slug,
        namespace: inputs.previewNamespace,
        body: deployment,
      }),
  );
  await applyOrReplace(
    slug,
    () =>
      clients.core.createNamespacedService({
        namespace: inputs.previewNamespace,
        body: service,
      }),
    () =>
      clients.core.replaceNamespacedService({
        name: slug,
        namespace: inputs.previewNamespace,
        body: service,
      }),
  );
  await applyOrReplace(
    slug,
    () =>
      clients.networking.createNamespacedIngress({
        namespace: inputs.previewNamespace,
        body: ingress,
      }),
    () =>
      clients.networking.replaceNamespacedIngress({
        name: slug,
        namespace: inputs.previewNamespace,
        body: ingress,
      }),
  );

  // Step 3: wait for the pod to become ready
  await waitForDeploymentReady(clients, slug, inputs.previewNamespace);

  return { url: selfUrl, slug, image, jobName };
}
