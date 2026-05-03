import * as yaml from "js-yaml";

/**
 * `.x1agent/preview.yaml` parser and validator. v1 supports the
 * Dockerfile entrypoint only; other kinds (compose, helm, kustomize,
 * manifest) are accepted by the schema but `parsePreviewSpec` returns
 * a typed `{ kind: "dockerfile" }` union only for the supported kind
 * and flags the rest as errors.
 *
 * The canonical format is documented in
 * docs/src/content/docs/reference/preview-spec.md.
 */
export interface DockerfileEntrypoint {
  kind: "dockerfile";
  path: string;
  buildContext: string;
}

export interface PreviewRuntime {
  port: number;
  healthcheck: {
    path: string;
    initialDelaySeconds: number;
    periodSeconds: number;
  };
}

export interface PreviewEnvVar {
  name: string;
  value?: string;
  /**
   * Compact scheme:
   *   "preview.self_url"  → resolved at deploy time to the preview URL
   *   "secret:<NAME>"     → workspace secret reference, resolved at
   *                         deploy via the secret bundle (Zone-2
   *                         analogue for previews — see
   *                         docs/security/agent-env.md § Preview
   *                         environments)
   */
  from?: string;
}

const SECRET_FROM_RE = /^secret:[A-Z_][A-Z0-9_]{0,63}$/;

/** Returns the workspace-secret name when `from` matches `secret:<NAME>`, else null. */
export function parseSecretFrom(from: string | undefined): string | null {
  if (!from || !SECRET_FROM_RE.test(from)) return null;
  return from.slice("secret:".length);
}

export interface PreviewResources {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}

export interface PreviewSpec {
  apiVersion: "x1agent.io/v1";
  kind: "PreviewSpec";
  metadata: { name: string };
  spec: {
    entrypoint: DockerfileEntrypoint;
    runtime: PreviewRuntime;
    env: PreviewEnvVar[];
    resources: PreviewResources;
  };
}

export class PreviewSpecError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

/**
 * Parse and validate the YAML content of a `.x1agent/preview.yaml`
 * file. Throws PreviewSpecError with a specific field path on the
 * first validation failure; the caller surfaces it back to the
 * orchestrator.
 */
export function parsePreviewSpec(yamlContent: string): PreviewSpec {
  let raw: unknown;
  try {
    raw = yaml.load(yamlContent);
  } catch (err) {
    throw new PreviewSpecError(
      "<root>",
      `yaml parse failed: ${(err as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new PreviewSpecError("<root>", "must be a YAML object");
  }
  const r = raw as Record<string, unknown>;

  if (r.apiVersion !== "x1agent.io/v1") {
    throw new PreviewSpecError(
      "apiVersion",
      `expected 'x1agent.io/v1', got ${JSON.stringify(r.apiVersion)}`,
    );
  }
  if (r.kind !== "PreviewSpec") {
    throw new PreviewSpecError(
      "kind",
      `expected 'PreviewSpec', got ${JSON.stringify(r.kind)}`,
    );
  }

  const metadata = (r.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.name !== "string" || !metadata.name) {
    throw new PreviewSpecError("metadata.name", "required, non-empty string");
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(metadata.name)) {
    throw new PreviewSpecError(
      "metadata.name",
      "must match /^[a-z][a-z0-9-]{0,62}$/ (K8s DNS-1123 label)",
    );
  }

  const spec = (r.spec ?? {}) as Record<string, unknown>;
  const entrypoint = (spec.entrypoint ?? {}) as Record<string, unknown>;
  if (entrypoint.kind !== "dockerfile") {
    throw new PreviewSpecError(
      "spec.entrypoint.kind",
      `v1 only supports kind='dockerfile', got ${JSON.stringify(entrypoint.kind)}`,
    );
  }
  if (typeof entrypoint.path !== "string" || !entrypoint.path) {
    throw new PreviewSpecError(
      "spec.entrypoint.path",
      "required, non-empty string (e.g. './Dockerfile')",
    );
  }
  const buildContext =
    typeof entrypoint.buildContext === "string" && entrypoint.buildContext
      ? entrypoint.buildContext
      : ".";

  const runtime = (spec.runtime ?? {}) as Record<string, unknown>;
  if (typeof runtime.port !== "number" || runtime.port < 1 || runtime.port > 65535) {
    throw new PreviewSpecError(
      "spec.runtime.port",
      "required integer in 1-65535",
    );
  }
  const hc = (runtime.healthcheck ?? {}) as Record<string, unknown>;
  if (typeof hc.path !== "string" || !hc.path.startsWith("/")) {
    throw new PreviewSpecError(
      "spec.runtime.healthcheck.path",
      "required, must start with '/' (e.g. '/healthz')",
    );
  }
  const initialDelaySeconds =
    typeof hc.initialDelaySeconds === "number" ? hc.initialDelaySeconds : 15;
  const periodSeconds =
    typeof hc.periodSeconds === "number" ? hc.periodSeconds : 10;

  const env: PreviewEnvVar[] = Array.isArray(spec.env)
    ? spec.env.map((e, i) => {
        const ev = (e ?? {}) as Record<string, unknown>;
        if (typeof ev.name !== "string" || !ev.name) {
          throw new PreviewSpecError(
            `spec.env[${i}].name`,
            "required, non-empty string",
          );
        }
        const from = typeof ev.from === "string" ? ev.from : undefined;
        if (
          from &&
          from !== "preview.self_url" &&
          parseSecretFrom(from) === null
        ) {
          throw new PreviewSpecError(
            `spec.env[${i}].from`,
            "must be 'preview.self_url' or 'secret:<NAME>' where NAME matches ^[A-Z_][A-Z0-9_]{0,63}$",
          );
        }
        return {
          name: ev.name,
          value: typeof ev.value === "string" ? ev.value : undefined,
          from,
        };
      })
    : [];

  const resources = (spec.resources ?? {}) as Record<string, unknown>;
  const req = (resources.requests ?? {}) as Record<string, unknown>;
  const lim = (resources.limits ?? {}) as Record<string, unknown>;
  const requests = {
    cpu: typeof req.cpu === "string" ? req.cpu : "200m",
    memory: typeof req.memory === "string" ? req.memory : "512Mi",
  };
  const limits = {
    cpu: typeof lim.cpu === "string" ? lim.cpu : "1",
    memory: typeof lim.memory === "string" ? lim.memory : "1Gi",
  };

  return {
    apiVersion: "x1agent.io/v1",
    kind: "PreviewSpec",
    metadata: { name: metadata.name },
    spec: {
      entrypoint: {
        kind: "dockerfile",
        path: entrypoint.path,
        buildContext,
      },
      runtime: {
        port: runtime.port,
        healthcheck: {
          path: hc.path,
          initialDelaySeconds,
          periodSeconds,
        },
      },
      env,
      resources: { requests, limits },
    },
  };
}
