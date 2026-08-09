import type { V1Deployment, V1Service, V1Ingress, V1Job } from "@kubernetes/client-node";
import { type PreviewSpec, parseSecretFrom } from "./preview-spec.js";

/**
 * All K8s manifest generation for the preview provider. Pure
 * functions — no cluster calls, no I/O. Keeps build logic testable
 * and lets callers diff the output in PRs when templates change.
 *
 * Output targets the local-k8s preview namespace (default
 * `x1-previews`). The deploy path creates these in order:
 *   1. buildKanikoJob — clones the repo at the requested sha,
 *      builds the Dockerfile, pushes to the in-cluster registry.
 *      Runs to completion before the Deployment is created.
 *   2. buildDeployment — references the image the Kaniko job just
 *      pushed. One replica, matching the runtime spec.
 *   3. buildService — ClusterIP targeting the Deployment.
 *   4. buildIngress — public-facing URL on
 *      <slug>.preview.local.x1agent.dev with TLS from the wildcard
 *      cert managed at the platform level (secretName
 *      'x1agent-wildcard').
 */

export interface PreviewDeploymentInputs {
  /** Preview slug — matches preview spec metadata.name. Used as the K8s name for Deployment/Service/Ingress. */
  slug: string;
  /** Namespace to deploy into; defaults to 'x1-previews'. */
  namespace: string;
  /** Fully-qualified image reference the Deployment pulls. */
  image: string;
  /** Parsed spec; drives ports, env, resources, healthcheck. */
  spec: PreviewSpec;
  /** The host the ingress should route. */
  host: string;
  /** TLS secret name in the namespace (mkcert wildcard in dev). */
  tlsSecretName: string;
  /** URL the agent can address this preview at. Used for env 'preview.self_url'. */
  selfUrl: string;
  /**
   * Optional name of a per-preview K8s Secret in the same namespace
   * holding workspace-secret values keyed by their workspace_secrets
   * name. When the spec uses any `from: secret:<NAME>` env var,
   * deploy.ts mints this Secret first and passes the name here so
   * the Deployment can reference it via valueFrom.secretKeyRef.
   * Plaintext never lands in this manifest.
   */
  secretBundleName?: string;
  /**
   * Names of workspace env-binding values the preview opted into. The
   * plaintext is already in `secretBundleName`'s stringData, keyed by
   * env-var name (see deploy.ts: stringData[envName] = value). Each
   * name listed here becomes a container env var that reads from the
   * bundle. On name collision with spec.env, the binding wins — the
   * spec entry is dropped — matching the existing "extraEnv collisions
   * win since they're the explicit per-environment override" rule
   * documented in deploy.ts.
   */
  extraEnvNames?: readonly string[];
  /**
   * Additional hostnames the Ingress should answer on, beyond the
   * default `host`. Each alias gets its own TLS entry (with a
   * per-alias secretName cert-manager mints via ingress-shim) and
   * its own Ingress rule pointing at the same Service. Operator-owned
   * DNS for each alias must already CNAME at the cluster ingress.
   */
  aliasHosts?: readonly string[];
  /**
   * cert-manager ClusterIssuer to annotate the Ingress with when
   * `aliasHosts` is non-empty. Setting this on the annotation tells
   * ingress-shim to mint a Certificate for each per-alias TLS entry's
   * secretName. Defaults are platform-supplied; the chart wires this
   * to the install's prod issuer.
   */
  aliasClusterIssuer?: string;
}

export interface KanikoBuildInputs {
  /** Unique Job name (prefix). Typically 'preview-build-<slug>-<short_sha>'. */
  jobName: string;
  /** Namespace the Job runs in; same namespace as the api so RBAC stays scoped. */
  namespace: string;
  /** Git repo URL (https://...) including any auth prefix Kaniko needs. */
  gitUrl: string;
  /** Commit sha or branch ref to clone; Kaniko supports '#refs/heads/<branch>' form. */
  gitRef: string;
  /** Path inside the repo to the Dockerfile. */
  dockerfilePath: string;
  /** Path inside the repo to use as the build context. */
  buildContext: string;
  /** Destination image ref Kaniko pushes to (e.g. 'x1-registry.x1agent.svc.cluster.local:5000/previews/slug:sha'). */
  destination: string;
  /** When the registry is HTTP (dev in-cluster), Kaniko needs --insecure. */
  insecureRegistry: boolean;
  /**
   * GitHub App installation token. Injected into the clone URL as
   * 'x-access-token:<token>@' — Kaniko gets a working clone without
   * seeing the long-lived app private key.
   */
  accessToken: string;
  /**
   * Optional KSA name the Kaniko Pod runs under. When the destination
   * is Artifact Registry, this KSA must be Workload-Identity-bound to
   * a GSA with roles/artifactregistry.writer on the target repo, so
   * Kaniko's push uses the GCE metadata server for auth (no JSON key).
   * Falls back to the namespace's `default` SA when empty — fine for
   * the dev in-cluster HTTP registry.
   */
  serviceAccountName?: string;
}

export function buildKanikoJob(inputs: KanikoBuildInputs): V1Job {
  const labels = {
    app: "x1agent",
    component: "preview-build",
    "preview-slug": inputs.jobName.replace(/^preview-build-/, "").slice(0, 63),
  };

  // Kaniko's `--context=git://...` clone URL embeds the token so the
  // build pod doesn't need the app's private key. The token is
  // short-lived (GitHub mints 1-hour installation tokens) and is
  // scoped to this one build's clone.
  const contextUrl =
    inputs.gitUrl.replace(
      /^https:\/\//,
      `git://x-access-token:${inputs.accessToken}@`,
    ) + "#" + inputs.gitRef;

  const args = [
    `--context=${contextUrl}`,
    `--dockerfile=${inputs.dockerfilePath}`,
    `--destination=${inputs.destination}`,
    // Skip tls verify for the in-cluster registry (HTTP) while using
    // TLS for GitHub — Kaniko accepts both flags and applies them per
    // destination.
    ...(inputs.insecureRegistry
      ? ["--insecure", "--skip-tls-verify"]
      : []),
    "--cache=false",
    "--snapshot-mode=redo",
    "--single-snapshot",
  ];

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: inputs.jobName,
      namespace: inputs.namespace,
      labels,
    },
    spec: {
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: 1800,
      backoffLimit: 1,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          ...(inputs.serviceAccountName
            ? { serviceAccountName: inputs.serviceAccountName }
            : {}),
          securityContext: {
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "kaniko",
              image: "gcr.io/kaniko-project/executor:latest",
              args,
              securityContext: {
                // Kaniko unpacks base-image tarballs into / and chowns
                // files like /etc/shadow during rootfs unpacking. With
                // capabilities.drop: ["ALL"] the chown fails ("operation
                // not permitted") and the build aborts before the
                // user's Dockerfile even runs. Default cap set keeps
                // the standard restricted-runtime baseline (the pod
                // template's seccompProfile=RuntimeDefault stays on)
                // and Kaniko has the chown/setuid/setgid/fowner caps
                // it needs.
                allowPrivilegeEscalation: false,
              },
              resources: {
                requests: { cpu: "500m", memory: "1Gi" },
                limits: { cpu: "2", memory: "4Gi" },
              },
            },
          ],
        },
      },
    },
  };
}

export function buildDeployment(
  inputs: PreviewDeploymentInputs,
): V1Deployment {
  const labels = {
    app: inputs.slug,
    "x1-preview": "true",
    "x1-component": "preview-app",
  };
  const extraEnvNames = inputs.extraEnvNames ?? [];
  const overriddenBySpec = new Set(extraEnvNames);
  const specEnvVars = inputs.spec.spec.env
    .filter((e) => !overriddenBySpec.has(e.name))
    .map((e) => {
      if (e.from === "preview.self_url") {
        return { name: e.name, value: inputs.selfUrl };
      }
      const secretName = parseSecretFrom(e.from);
      if (secretName) {
        if (!inputs.secretBundleName) {
          // Spec asked for a workspace secret but the deploy path
          // didn't mint a bundle. Emit empty string and let the app
          // surface its own missing-config error rather than silently
          // crashing the pod with a Secret-not-found event.
          return { name: e.name, value: "" };
        }
        return {
          name: e.name,
          valueFrom: {
            secretKeyRef: {
              name: inputs.secretBundleName,
              key: secretName,
            },
          },
        };
      }
      return { name: e.name, value: e.value ?? "" };
    });
  // Workspace env-binding values land here. deploy.ts has already
  // written each name into the bundle's stringData keyed by env-var
  // name; we only need a secretKeyRef per entry. Skip silently when no
  // bundle exists — deploy.ts only sets extraEnvNames when the bundle
  // is minted, so this branch is defensive against future callers.
  const extraEnvVars = inputs.secretBundleName
    ? extraEnvNames.map((name) => ({
        name,
        valueFrom: {
          secretKeyRef: {
            name: inputs.secretBundleName!,
            key: name,
          },
        },
      }))
    : [];
  const envVars = [...specEnvVars, ...extraEnvVars];
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: inputs.slug,
      namespace: inputs.namespace,
      labels,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: inputs.slug } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: "app",
              image: inputs.image,
              imagePullPolicy: "IfNotPresent",
              ports: [{ containerPort: inputs.spec.spec.runtime.port }],
              env: envVars,
              resources: {
                requests: inputs.spec.spec.resources.requests,
                limits: inputs.spec.spec.resources.limits,
              },
              readinessProbe: {
                httpGet: {
                  path: inputs.spec.spec.runtime.healthcheck.path,
                  port: inputs.spec.spec.runtime.port,
                },
                initialDelaySeconds:
                  inputs.spec.spec.runtime.healthcheck.initialDelaySeconds,
                periodSeconds:
                  inputs.spec.spec.runtime.healthcheck.periodSeconds,
              },
              livenessProbe: {
                httpGet: {
                  path: inputs.spec.spec.runtime.healthcheck.path,
                  port: inputs.spec.spec.runtime.port,
                },
                initialDelaySeconds:
                  inputs.spec.spec.runtime.healthcheck.initialDelaySeconds * 2,
                periodSeconds:
                  inputs.spec.spec.runtime.healthcheck.periodSeconds * 3,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  };
}

export function buildService(inputs: PreviewDeploymentInputs): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: inputs.slug,
      namespace: inputs.namespace,
    },
    spec: {
      selector: { app: inputs.slug },
      ports: [
        {
          port: 80,
          targetPort: inputs.spec.spec.runtime.port,
          protocol: "TCP",
        },
      ],
    },
  };
}

/**
 * Per-alias TLS secretName. Stable across deploys (same input host
 * yields the same secret name) so cert-manager can reuse the issued
 * Certificate instead of provisioning a new one each time.
 *
 * Uses a SHA-256 truncated to 16 hex chars (64 bits). Earlier
 * iterations used FNV-1a 32-bit — collisions are findable in ~65k
 * tries against a chosen target with that hash, which would let a
 * malicious admin grind alias-host strings until the secretName
 * matches another tenant's existing alias Secret in the shared
 * `x1-previews` namespace. SHA-256@64-bit raises the cost to ~2^32
 * tries to chosen-collide a specific secretName, with no realistic
 * birthday-collision risk across the alias count we cap at.
 *
 * Format: `alias-<slug>-<16-hex>`. DNS-1123 subdomain compliant; the
 * 253-char K8s limit is irrelevant for sensible slug lengths.
 */
export function aliasTlsSecretName(slug: string, host: string): string {
  // Use Node's built-in crypto for SHA-256. The provider always runs
  // under Node/Bun; this import is sync and zero-cost on cold start.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const tag = createHash("sha256").update(host).digest("hex").slice(0, 16);
  // Slug is already DNS-1123-validated upstream; trim only if the
  // combined name would exceed 63 chars (the safe label limit for
  // most clients, not the 253 subdomain ceiling).
  const base = `alias-${slug}-${tag}`;
  return base.length <= 63 ? base : base.slice(0, 63);
}

export function buildIngress(inputs: PreviewDeploymentInputs): V1Ingress {
  const aliasHosts = (inputs.aliasHosts ?? []).filter(
    // Drop anything matching the default host so we don't double-emit.
    (h) => h && h !== inputs.host,
  );

  const ingressBackend = {
    service: { name: inputs.slug, port: { number: 80 } },
  } as const;
  const ingressPath = {
    path: "/",
    pathType: "Prefix" as const,
    backend: ingressBackend,
  };

  const tls = [
    { hosts: [inputs.host], secretName: inputs.tlsSecretName },
    ...aliasHosts.map((h) => ({
      hosts: [h],
      secretName: aliasTlsSecretName(inputs.slug, h),
    })),
  ];
  const rules = [inputs.host, ...aliasHosts].map((h) => ({
    host: h,
    http: { paths: [ingressPath] },
  }));

  const annotations: Record<string, string> = {
    "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
  };
  // When aliases are present, tell cert-manager's ingress-shim to
  // mint a Certificate for each non-wildcard TLS entry's secretName.
  // The wildcard cert backing the default host already exists and
  // is left untouched.
  if (aliasHosts.length > 0 && inputs.aliasClusterIssuer) {
    annotations["cert-manager.io/cluster-issuer"] = inputs.aliasClusterIssuer;
  }

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: inputs.slug,
      namespace: inputs.namespace,
      annotations,
    },
    spec: {
      ingressClassName: "traefik",
      tls,
      rules,
    },
  };
}
