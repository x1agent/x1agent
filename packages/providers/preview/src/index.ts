// initOtel must run BEFORE any auto-instrumented imports (nats /
// undici / k8s client). No-op when collector endpoint isn't set.
import { initOtel } from "@x1agent/observability";
initOtel({ serviceName: "x1agent-provider-preview" });

/**
 * Preview provider entry point. Listens on NATS for provision
 * requests from the api, builds an image via Kaniko, applies
 * Deployment/Service/Ingress, and returns the public URL.
 *
 * NATS subject: `x1.provider.preview.provision`
 * Request shape:
 *   {
 *     preview_yaml: string,
 *     repo_full_name: string,
 *     branch: string,
 *     commit_sha: string,
 *     installation_id: number,
 *     secret_values?: Record<string, string>, // pre-resolved workspace secrets
 *   }
 * Reply shape (success):
 *   { ok: true, url, slug, image, job_name }
 * Reply shape (failure):
 *   { ok: false, code, message }
 *
 * Runtime config comes entirely from env — the provider is
 * deployment-agnostic:
 *   NATS_URL, NATS_CA_FILE, NATS_CLIENT_CERT, NATS_CLIENT_KEY
 *   API_URL, API_INTERNAL_TOKEN
 *   REGISTRY_ADDRESS, REGISTRY_INSECURE
 *   BUILD_NAMESPACE, PREVIEW_NAMESPACE
 *   PREVIEW_DOMAIN, TLS_SECRET_NAME
 */
import { connect, JSONCodec, type Msg } from "nats";
import { readFileSync } from "node:fs";
import * as k8s from "@kubernetes/client-node";
import { deployPreview, DeployError } from "./deploy.js";

interface ProvisionRequest {
  preview_yaml?: string;
  repo_full_name?: string;
  branch?: string;
  commit_sha?: string;
  installation_id?: number;
  /**
   * Pre-resolved workspace secret values keyed by workspace_secrets.name,
   * used when the spec has `from: secret:<NAME>` env vars. The api side
   * resolves these from the workspace_secrets store before publishing
   * (Zone 2 for previews — see docs/security/agent-env.md).
   */
  secret_values?: Record<string, string>;
}

type ProvisionReply =
  | {
      ok: true;
      url: string;
      slug: string;
      image: string;
      job_name: string;
    }
  | { ok: false; code: string; message: string };

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[preview] missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

function readFileOrUndef(path: string | undefined): Uint8Array | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

async function main() {
  const natsUrl = requireEnv("NATS_URL");
  const apiUrl = requireEnv("API_URL");
  const apiInternalToken = requireEnv("API_INTERNAL_TOKEN");
  const registryAddress = requireEnv("REGISTRY_ADDRESS");
  const registryInsecure = process.env.REGISTRY_INSECURE === "true";
  const buildNamespace = process.env.BUILD_NAMESPACE || "x1agent";
  const buildServiceAccount = process.env.BUILD_SERVICE_ACCOUNT || undefined;
  const previewNamespace = process.env.PREVIEW_NAMESPACE || "x1-previews";
  const previewDomain =
    process.env.PREVIEW_DOMAIN || "preview.local.x1agent.dev";
  const tlsSecretName = process.env.TLS_SECRET_NAME || "x1agent-wildcard";

  const nc = await connect({
    servers: natsUrl,
    name: "x1agent-provider-preview",
    reconnect: true,
    maxReconnectAttempts: -1,
    tls: {
      ca: readFileOrUndef(process.env.NATS_CA_FILE),
      cert: readFileOrUndef(process.env.NATS_CLIENT_CERT),
      key: readFileOrUndef(process.env.NATS_CLIENT_KEY),
    },
  });
  console.log(`[preview] connected to NATS ${natsUrl}`);

  // Load k8s config. In-cluster via ServiceAccount by default; falls
  // back to KUBECONFIG for local testing.
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
    console.log(`[preview] kube config loaded from cluster`);
  } catch {
    kc.loadFromDefault();
    console.log(`[preview] kube config loaded from local KUBECONFIG`);
  }

  const jc = JSONCodec<ProvisionRequest>();
  const jcReply = JSONCodec<ProvisionReply>();

  const subject = "x1.provider.preview.provision";
  const sub = nc.subscribe(subject, { queue: "preview-provisioners" });
  console.log(`[preview] subscribed to ${subject}`);

  (async () => {
    for await (const m of sub) {
      void handleProvision(m);
    }
  })().catch((err) => {
    console.error(`[preview] subscriber loop exited: ${(err as Error).message}`);
  });

  async function handleProvision(msg: Msg) {
    let req: ProvisionRequest;
    try {
      req = jc.decode(msg.data);
    } catch (err) {
      msg.respond(
        jcReply.encode({
          ok: false,
          code: "bad_request_decode",
          message: (err as Error).message,
        }),
      );
      return;
    }

    if (
      !req.preview_yaml ||
      !req.repo_full_name ||
      !req.branch ||
      !req.commit_sha ||
      typeof req.installation_id !== "number"
    ) {
      msg.respond(
        jcReply.encode({
          ok: false,
          code: "missing_fields",
          message:
            "required: preview_yaml, repo_full_name, branch, commit_sha, installation_id",
        }),
      );
      return;
    }

    const startedAt = Date.now();
    console.log(
      `[preview] provision start repo=${req.repo_full_name} branch=${req.branch} sha=${req.commit_sha.slice(0, 12)}`,
    );
    try {
      const result = await deployPreview(kc, {
        previewYaml: req.preview_yaml,
        repoFullName: req.repo_full_name,
        branch: req.branch,
        commitSha: req.commit_sha,
        installationId: req.installation_id,
        registryAddress,
        registryInsecure,
        buildNamespace,
        buildServiceAccount,
        previewNamespace,
        previewDomain,
        tlsSecretName,
        apiUrl,
        apiInternalToken,
        secretValues:
          typeof req.secret_values === "object" &&
          req.secret_values !== null &&
          !Array.isArray(req.secret_values)
            ? (req.secret_values as Record<string, string>)
            : undefined,
      });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[preview] provision ok slug=${result.slug} url=${result.url} elapsed=${elapsed}s`,
      );
      msg.respond(
        jcReply.encode({
          ok: true,
          url: result.url,
          slug: result.slug,
          image: result.image,
          job_name: result.jobName,
        }),
      );
    } catch (err) {
      const code = err instanceof DeployError ? err.code : "internal_error";
      const message = (err as Error).message ?? "provision failed";
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.warn(
        `[preview] provision failed code=${code} elapsed=${elapsed}s: ${message}`,
      );
      msg.respond(jcReply.encode({ ok: false, code, message }));
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      console.log(`[preview] received ${signal}, draining`);
      await sub.unsubscribe();
      await nc.drain();
      process.exit(0);
    });
  }

  console.log(`[preview] provider ready`);
}

main().catch((err) => {
  console.error(`[preview] fatal: ${(err as Error).message}`);
  process.exit(1);
});
