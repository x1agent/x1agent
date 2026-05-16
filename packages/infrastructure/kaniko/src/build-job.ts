import type { V1Job } from "@kubernetes/client-node";

/**
 * Build-context source for a Kaniko Job. Two modes:
 *
 *   * `git` — Kaniko clones the repo at `ref` and reads the
 *     Dockerfile from inside the working tree. Used by the preview
 *     provider where the user's source repo IS the build context.
 *
 *   * `inline` — the Dockerfile lives in a per-build ConfigMap
 *     mounted at `/build-ctx/Dockerfile`. No surrounding context.
 *     Used by the image catalog where workspace admins author a
 *     standalone Dockerfile in the UI.
 *
 * `inline` Dockerfiles cannot reference local files (no `COPY ./x`)
 * because the ConfigMap is the entire build context. The image
 * catalog's `DockerfileSource` validator rejects local `COPY` and
 * `ADD` upstream of this layer.
 */
export type BuildContext =
  | {
      kind: "git";
      gitUrl: string;
      gitRef: string;
      dockerfilePath: string;
      buildContext: string;
      /** GitHub App installation token. Embedded in the clone URL as
       * `x-access-token:<token>@`; short-lived (1 h) so leaking the Job
       * spec doesn't leak the long-lived app credential. */
      accessToken: string;
    }
  | {
      kind: "inline";
      /** Name of a ConfigMap in the same namespace as the Job. The
       * ConfigMap MUST have a `Dockerfile` key. The builder is
       * responsible for creating the ConfigMap before creating the
       * Job and deleting it after the Job terminates. */
      configMapName: string;
    };

export interface KanikoBuildInputs {
  /** Unique Job name (DNS-1123 label, ≤63 chars). */
  jobName: string;
  /** Namespace the Job runs in. */
  namespace: string;
  /** Destination image ref Kaniko pushes to. Tag-only; the digest is
   * recovered from the Job's terminationMessage after success. */
  destination: string;
  /** When the registry is HTTP (in-cluster dev), Kaniko needs --insecure. */
  insecureRegistry: boolean;
  /** What Kaniko reads as its build context. */
  context: BuildContext;
  /** Extra labels merged onto Job + Pod. */
  labels?: Record<string, string>;
  /** Override the default Kaniko image — pin a digest in production. */
  kanikoImage?: string;
  /** Override compute. Defaults are 500m/1Gi req, 2/4Gi limit. */
  resources?: {
    requests?: { cpu: string; memory: string };
    limits?: { cpu: string; memory: string };
  };
  /**
   * Optional KSA the Kaniko Pod runs as. Required for Artifact Registry
   * pushes — the KSA must be Workload-Identity-bound to a GSA with
   * roles/artifactregistry.writer on the destination repo. Falls back to
   * the namespace default SA when empty (fine for dev's in-cluster
   * HTTP registry but the prod push will fail with
   * `artifactregistry.repositories.uploadArtifacts denied`).
   */
  serviceAccountName?: string;
}

const DEFAULT_KANIKO_IMAGE = "gcr.io/kaniko-project/executor:latest";

/**
 * Build a Kaniko Job spec. Pure function, no I/O — the caller creates
 * the Job (and any ConfigMap) via the K8s API.
 *
 * Recovering the pushed digest after success: the Job writes
 * `<image>@sha256:<digest>` to `/dev/termination-log` via Kaniko's
 * `--image-name-with-digest-file`. The caller reads the digest from
 * the pod's `status.containerStatuses[0].state.terminated.message`
 * once the Job's `succeeded` count is ≥ 1.
 */
export function buildKanikoJob(inputs: KanikoBuildInputs): V1Job {
  const labels: Record<string, string> = {
    app: "x1agent",
    component: "kaniko-build",
    ...(inputs.labels ?? {}),
  };

  const args: string[] = [
    `--destination=${inputs.destination}`,
    "--cache=false",
    "--snapshot-mode=redo",
    "--single-snapshot",
    "--image-name-with-digest-file=/dev/termination-log",
    ...(inputs.insecureRegistry
      ? ["--insecure", "--skip-tls-verify"]
      : []),
  ];

  let volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> | undefined;
  let volumes: Array<{ name: string; configMap?: { name: string } }> | undefined;

  if (inputs.context.kind === "git") {
    const ctx = inputs.context;
    const contextUrl =
      ctx.gitUrl.replace(
        /^https:\/\//,
        `git://x-access-token:${ctx.accessToken}@`,
      ) + "#" + ctx.gitRef;
    args.push(`--context=${contextUrl}`);
    args.push(`--dockerfile=${ctx.dockerfilePath}`);
    void ctx.buildContext; // currently unused — Kaniko reads from the cloned tree
  } else {
    args.push("--context=dir:///build-ctx");
    args.push("--dockerfile=/build-ctx/Dockerfile");
    volumeMounts = [
      { name: "build-ctx", mountPath: "/build-ctx", readOnly: true },
    ];
    volumes = [
      { name: "build-ctx", configMap: { name: inputs.context.configMapName } },
    ];
  }

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
              image: inputs.kanikoImage ?? DEFAULT_KANIKO_IMAGE,
              args,
              volumeMounts,
              terminationMessagePolicy: "File",
              securityContext: {
                // Kaniko needs CAP_CHOWN, CAP_FOWNER, CAP_DAC_OVERRIDE
                // (and friends) to unpack base-image rootfs ownership.
                // Dropping ALL caps fails with
                // `chown /etc/gshadow: operation not permitted` on the
                // first RUN. Run as uid 0 with the default capability
                // set, and rely on seccomp + the Job's namespace-scoped
                // RBAC (no host network, no host pid) for isolation.
                allowPrivilegeEscalation: false,
                runAsUser: 0,
              },
              resources: inputs.resources ?? {
                requests: { cpu: "500m", memory: "1Gi" },
                limits: { cpu: "2", memory: "4Gi" },
              },
            },
          ],
          volumes,
        },
      },
    },
  };
}

/**
 * Parse a Kaniko `--image-name-with-digest-file` payload to recover
 * the registry-pinned digest. Kaniko writes a single line of the form:
 *
 *   <registry>/<path>:<tag>@sha256:<digest>
 *
 * Returns null if the payload doesn't match (corrupt / truncated).
 */
export function parseDigestFromTerminationMessage(
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  const m = trimmed.match(/(.+)@sha256:([0-9a-f]{64})\b/);
  if (!m) return null;
  // Normalize: strip the tag from the image part and reattach the digest.
  // Kaniko's `--image-name-with-digest-file` may or may not include the
  // `:tag`, depending on version. Only strip a trailing `:tag` when the
  // colon comes AFTER the last `/` — colons before the first `/` are
  // part of `host:port` (e.g. `localhost:5000`) and must be preserved.
  const imageWithTag = m[1]!;
  const digest = m[2]!;
  const lastSlash = imageWithTag.lastIndexOf("/");
  const lastColon = imageWithTag.lastIndexOf(":");
  const imageNoTag =
    lastColon > lastSlash
      ? imageWithTag.slice(0, lastColon)
      : imageWithTag;
  return `${imageNoTag}@sha256:${digest}`;
}
