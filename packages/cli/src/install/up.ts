import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  spinner,
} from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EnvFile } from "../configure/env-file.ts";
import {
  findRepoRoot,
  resolveActiveDeployment,
  resolveActiveDeploymentInteractive,
} from "../configure/paths.ts";
import { runCheck } from "../configure/check.ts";
import { defaultPaths, render, renderTerraformVars } from "./render.ts";
import { runInstallPreflight, reportFailures } from "./preflight.ts";
import { printActiveTargetHeader } from "../active-target.ts";

/**
 * One-shot installer. Runs every phase needed to take a cluster from
 * empty to "x1agent serving https://app.<basedomain>" — terraform,
 * cluster credentials, operator helm charts (ESO + cert-manager +
 * Traefik), Workload Identity annotations, GSM secret population,
 * image build + push, chart install, status wait.
 *
 * Idempotent: every phase short-circuits when the work it does is
 * already in place. Re-runs are safe — useful when a single phase
 * fails (network blip, quota, etc.) and you just want to resume.
 *
 * Each phase is gated; the next phase only runs if its predecessor
 * succeeded. The first failure stops the loop with a clear message.
 */

const RELEASE = "x1agent";
const NAMESPACE = "x1agent";
const ESO_NS = "external-secrets";
const CERTMGR_NS = "cert-manager";
const TRAEFIK_NS = "traefik";

export async function runInstallUp(
  opts: { autoConfirm?: boolean } = {},
): Promise<boolean> {
  intro("x1agent install");

  // ── Phase 1: preflight ──────────────────────────────────────────
  const pf = await runInstallPreflight();
  if (!pf.ok) {
    reportFailures(pf.failures);
    cancel("Preflight failed.");
    return false;
  }

  // ── Phase 2: configure:check ────────────────────────────────────
  if (runCheck() !== 0) {
    cancel("Run `mise run configure:prod` to fix the values, then re-run.");
    return false;
  }

  const { baseDomain, path: envPath } =
    await resolveActiveDeploymentInteractive();
  printActiveTargetHeader({ baseDomain, envPath });
  const env = new EnvFile(envPath);
  const projectId = env.get("GCP_PROJECT_ID")!;
  const region = env.get("GCP_REGION") || "us-central1";

  // Final confirm before mutating cloud + cluster.
  note(
    `Deployment: ${baseDomain}\n` +
      `GCP project: ${projectId}\n` +
      `Region: ${region}\n\n` +
      `Will run, in order:\n` +
      `  1. terraform apply (cluster + IAM + GSM placeholders + AR + DNS + IP)\n` +
      `  2. fetch cluster credentials\n` +
      `  3. helm install: external-secrets, cert-manager, traefik\n` +
      `  4. annotate ESO + cert-manager K8s SAs for Workload Identity\n` +
      `  5. terraform apply (full — ClusterSecretStore now CRDs exist)\n` +
      `  6. push secret values from ${envPath} → Google Secret Manager\n` +
      `  7. build + push prod images to Artifact Registry\n` +
      `  8. helm install x1agent\n` +
      `  9. wait for ingress IP + cert-manager Certificates Ready\n\n` +
      `Resumable — every phase is idempotent, re-running picks up from where it stopped.`,
    "Plan",
  );
  if (opts.autoConfirm) {
    note("Auto-confirming via --yes flag.", "Plan");
  } else {
    const ok = await confirm({
      message: "Proceed?",
      initialValue: true,
    });
    if (isCancel(ok) || !ok) {
      cancel("Cancelled.");
      return false;
    }
  }

  // ── Phase 3: terraform apply (cluster pass) ─────────────────────
  if (!(await phaseTerraformCluster())) return false;

  // ── Phase 4: cluster credentials ────────────────────────────────
  if (!(await phaseClusterCredentials(projectId, region))) return false;

  // ── Phase 5: operator helm installs ─────────────────────────────
  if (!(await phaseOperatorCharts())) return false;

  // ── Phase 6: WI annotations ─────────────────────────────────────
  if (!(await phaseWorkloadIdentityAnnotations(projectId))) return false;

  // ── Phase 7: terraform apply (full) ─────────────────────────────
  if (!(await phaseTerraformFull())) return false;

  // ── Phase 8: GSM secret population ──────────────────────────────
  if (!(await phaseGsmSecrets(env, projectId))) return false;

  // ── Phase 9: build + push images ────────────────────────────────
  if (!(await phaseBuildImages())) return false;

  // ── Phase 10: helm install x1agent ──────────────────────────────
  if (!(await phaseHelmInstall())) return false;

  // ── Phase 11: wait + status ─────────────────────────────────────
  await phaseWaitAndReport(baseDomain);

  outro("Done. Open https://app." + baseDomain + " — first cert may take 5–15 min after this.");
  return true;
}

// ── Phase implementations ──────────────────────────────────────────

async function phaseTerraformCluster(): Promise<boolean> {
  const s = spinner();
  s.start("terraform: cluster + IAM + GSM placeholders + AR + DNS + IP…");
  const { envPath, terraformDir, tfStatePath } = defaultPaths();
  try {
    renderTerraformVars({ envPath, terraformDir });
  } catch (err) {
    s.stop("terraform tfvars render failed.");
    log.error((err as Error).message);
    return false;
  }
  // Run terraform init unconditionally — idempotent + handles new providers.
  if (
    !(await run(
      ["terraform", "init", "-input=false"],
      { cwd: terraformDir },
      "terraform init",
    ))
  ) {
    s.stop("terraform init failed.");
    return false;
  }
  // Targeted apply for the cluster pass.
  const stateFlags = ["-state=" + tfStatePath, "-state-out=" + tfStatePath];
  const targets = [
    "google_container_cluster.x1agent",
    "google_container_node_pool.primary",
    "google_service_account.api",
    "google_service_account.eso",
    "google_service_account.session",
    "google_service_account.cert_manager",
    "google_service_account_iam_binding.api_wi",
    "google_service_account_iam_binding.eso_wi",
    "google_service_account_iam_binding.session_wi",
    "google_service_account_iam_binding.cert_manager_wi",
    "google_project_iam_member.api_log_writer",
    "google_project_iam_member.api_metric_writer",
    "google_project_iam_member.session_vertex_user",
    "google_project_iam_member.cert_manager_dns_admin",
    "google_secret_manager_secret.secrets",
    "google_secret_manager_secret_iam_member.api_accessor",
    "google_secret_manager_secret_iam_member.eso_accessor",
    "google_artifact_registry_repository.x1agent",
    "google_artifact_registry_repository_iam_member.node_pull",
    "google_compute_address.ingress",
    "google_dns_managed_zone.x1agent",
    "google_dns_record_set.app",
    "google_dns_record_set.api",
    "google_dns_record_set.preview_wildcard",
    "kubernetes_namespace_v1.x1agent",
  ];
  const args = [
    "terraform",
    "apply",
    "-auto-approve",
    "-input=false",
    ...stateFlags,
    ...targets.flatMap((t) => ["-target=" + t]),
  ];
  if (
    !(await run(args, { cwd: terraformDir }, "terraform apply (cluster pass)"))
  ) {
    s.stop("terraform cluster pass failed.");
    return false;
  }
  s.stop("terraform: cluster pass done.");
  return true;
}

async function phaseTerraformFull(): Promise<boolean> {
  const s = spinner();
  s.start("terraform: full apply (creates ClusterSecretStore now CRDs exist)…");
  const { terraformDir, tfStatePath } = defaultPaths();
  if (
    !(await run(
      [
        "terraform",
        "apply",
        "-auto-approve",
        "-input=false",
        "-state=" + tfStatePath,
        "-state-out=" + tfStatePath,
      ],
      { cwd: terraformDir },
      "terraform apply (full)",
    ))
  ) {
    s.stop("terraform full pass failed.");
    return false;
  }
  s.stop("terraform: full pass done.");
  return true;
}

async function phaseClusterCredentials(
  projectId: string,
  region: string,
): Promise<boolean> {
  const s = spinner();
  s.start("Fetching GKE cluster credentials…");
  const ok = await run(
    [
      "gcloud",
      "container",
      "clusters",
      "get-credentials",
      "x1agent",
      "--region",
      region,
      "--project",
      projectId,
    ],
    {},
    "gcloud get-credentials",
  );
  s.stop(ok ? "Cluster credentials loaded." : "get-credentials failed.");
  return ok;
}

async function phaseOperatorCharts(): Promise<boolean> {
  const charts: Array<{
    name: string;
    chart: string;
    repo: string;
    ns: string;
    extraArgs: string[];
  }> = [
    {
      name: "external-secrets",
      chart: "external-secrets/external-secrets",
      repo: "https://charts.external-secrets.io",
      ns: ESO_NS,
      extraArgs: ["--set", "installCRDs=true"],
    },
    {
      name: "cert-manager",
      chart: "jetstack/cert-manager",
      repo: "https://charts.jetstack.io",
      ns: CERTMGR_NS,
      extraArgs: ["--set", "installCRDs=true"],
    },
    {
      name: "traefik",
      chart: "traefik/traefik",
      repo: "https://traefik.github.io/charts",
      ns: TRAEFIK_NS,
      // Claim the static IP terraform reserved. externalTrafficPolicy=Local
      // preserves source-IP for the api's audit logs.
      extraArgs: [
        "--set",
        "service.spec.loadBalancerIP=" + (await readIngressIp()),
        "--set",
        "service.spec.externalTrafficPolicy=Local",
        "--set",
        "ports.web.redirections.entryPoint.to=websecure",
        "--set",
        "ports.web.redirections.entryPoint.scheme=https",
        "--set",
        "ports.web.redirections.entryPoint.permanent=true",
        "--set",
        "ports.websecure.transport.respondingTimeouts.idleTimeout=3600s",
      ],
    },
  ];

  for (const c of charts) {
    const s = spinner();
    s.start(`helm: ${c.name}…`);
    // Idempotent helm repo add (re-add is no-op when already present).
    await run(
      ["helm", "repo", "add", c.chart.split("/")[0]!, c.repo, "--force-update"],
      {},
      "helm repo add",
    );
    await run(["helm", "repo", "update"], {}, "helm repo update");
    const ok = await run(
      [
        "helm",
        "upgrade",
        "--install",
        c.name,
        c.chart,
        "--namespace",
        c.ns,
        "--create-namespace",
        "--wait",
        "--timeout",
        "5m",
        ...c.extraArgs,
      ],
      {},
      "helm upgrade " + c.name,
    );
    s.stop(ok ? `${c.name} ready.` : `${c.name} failed.`);
    if (!ok) return false;
  }
  return true;
}

async function phaseWorkloadIdentityAnnotations(
  projectId: string,
): Promise<boolean> {
  const annotations: Array<{ ns: string; sa: string; gsa: string }> = [
    {
      ns: ESO_NS,
      sa: "external-secrets",
      gsa: `x1agent-eso@${projectId}.iam.gserviceaccount.com`,
    },
    {
      ns: CERTMGR_NS,
      sa: "cert-manager",
      gsa: `x1agent-cert-manager@${projectId}.iam.gserviceaccount.com`,
    },
  ];
  for (const a of annotations) {
    const s = spinner();
    s.start(`Annotating ${a.ns}/${a.sa} for Workload Identity…`);
    if (
      !(await run(
        [
          "kubectl",
          "-n",
          a.ns,
          "annotate",
          "sa",
          a.sa,
          `iam.gke.io/gcp-service-account=${a.gsa}`,
          "--overwrite",
        ],
        {},
        "kubectl annotate",
      ))
    ) {
      s.stop("annotation failed.");
      return false;
    }
    // Restart so the SA's projected token is re-read on next reconcile.
    if (
      !(await run(
        [
          "kubectl",
          "-n",
          a.ns,
          "rollout",
          "restart",
          // ESO chart names the deployment "external-secrets"; cert-manager
          // names theirs "cert-manager". Both happen to match the SA.
          `deploy/${a.sa}`,
        ],
        {},
        "kubectl rollout restart",
      ))
    ) {
      s.stop("rollout restart failed.");
      return false;
    }
    s.stop(`${a.ns}/${a.sa} annotated + restarted.`);
  }
  return true;
}

async function phaseGsmSecrets(env: EnvFile, projectId: string): Promise<boolean> {
  // Map of env-var name → GSM secret name. Mirrors the chart's
  // externalSecrets.bindings.
  const bindings: Array<{ envName: string; gsmName: string }> = [
    { envName: "JWT_SECRET", gsmName: "x1agent-jwt-secret" },
    { envName: "API_INTERNAL_TOKEN", gsmName: "x1agent-api-internal-token" },
    { envName: "ANTHROPIC_API_KEY", gsmName: "x1agent-anthropic-api-key" },
    { envName: "OPENAI_API_KEY", gsmName: "x1agent-openai-api-key" },
    { envName: "GOOGLE_OAUTH_CLIENT_ID", gsmName: "x1agent-google-oauth-client-id" },
    { envName: "GOOGLE_OAUTH_CLIENT_SECRET", gsmName: "x1agent-google-oauth-client-secret" },
    { envName: "GITHUB_APP_ID", gsmName: "x1agent-github-app-id" },
    { envName: "GITHUB_APP_SLUG", gsmName: "x1agent-github-app-slug" },
    { envName: "GITHUB_APP_CLIENT_ID", gsmName: "x1agent-github-app-client-id" },
    { envName: "GITHUB_APP_CLIENT_SECRET", gsmName: "x1agent-github-app-client-secret" },
    { envName: "GITHUB_APP_PRIVATE_KEY", gsmName: "x1agent-github-app-private-key" },
    { envName: "GITHUB_APP_WEBHOOK_SECRET", gsmName: "x1agent-github-app-webhook-secret" },
    { envName: "SLACK_BOT_TOKEN", gsmName: "x1agent-slack-bot-token" },
    { envName: "SLACK_PLATFORM_CLIENT_ID", gsmName: "x1agent-slack-platform-client-id" },
    { envName: "SLACK_PLATFORM_CLIENT_SECRET", gsmName: "x1agent-slack-platform-client-secret" },
    { envName: "SLACK_PLATFORM_SIGNING_SECRET", gsmName: "x1agent-slack-platform-signing-secret" },
    { envName: "SENTRY_DSN_API", gsmName: "x1agent-sentry-dsn-api" },
    { envName: "SENTRY_DSN_APP", gsmName: "x1agent-sentry-dsn-app" },
    { envName: "SENTRY_DSN_SIDECAR", gsmName: "x1agent-sentry-dsn-sidecar" },
  ];
  // Postgres password — auto-generated if not in env. Same hex secret format
  // as JWT, 24 bytes.
  const pgPwdEnvKey = "POSTGRES_PASSWORD";
  let pgPwd = env.get(pgPwdEnvKey);
  if (!pgPwd) {
    const { randomBytes } = await import("node:crypto");
    pgPwd = randomBytes(24).toString("hex");
    env.set(pgPwdEnvKey, pgPwd);
    env.save();
    log.info("Generated POSTGRES_PASSWORD and saved to deployment file.");
  }
  bindings.push({
    envName: pgPwdEnvKey,
    gsmName: "x1agent-postgres-password",
  });

  // Workspace secrets master key (AES-256-GCM, 32 bytes hex). Auto-
  // generated on first install if not in the install config and saved
  // back so re-runs are idempotent. Rotating breaks every row in
  // workspace_secrets (no re-encrypt path implemented yet) — installer
  // never overwrites an existing value.
  const wsKeyEnvKey = "WORKSPACE_SECRETS_MASTER_KEY";
  let wsKey = env.get(wsKeyEnvKey);
  if (!wsKey) {
    const { randomBytes } = await import("node:crypto");
    wsKey = randomBytes(32).toString("hex");
    env.set(wsKeyEnvKey, wsKey);
    env.save();
    log.info(
      "Generated WORKSPACE_SECRETS_MASTER_KEY and saved to deployment file. Rotating breaks all stored workspace secrets — keep this value safe.",
    );
  }
  bindings.push({
    envName: wsKeyEnvKey,
    gsmName: "x1agent-workspace-secrets-master-key",
  });

  // Push EVERY binding to GSM, even if value is empty. ESO binds
  // ALL keys at once into one K8s Secret; if any GSM secret has zero
  // versions, the whole bundle fails with "Secret does not exist".
  // Empty-value versions satisfy ESO; pods just see empty env vars
  // for unconfigured integrations.
  let pushed = 0;
  let placeholder = 0;
  for (const b of bindings) {
    const rawValue = env.get(b.envName) ?? "";
    const isPlaceholder = rawValue === "";
    // gcloud rejects truly empty stdin on `versions add`; use a single
    // newline as the placeholder payload. Pods see "\n" instead of "" —
    // identical for everything we use these for (boolean truthy checks).
    const value = isPlaceholder ? "\n" : rawValue;
    const s = spinner();
    s.start(
      isPlaceholder
        ? `Placeholder GSM ${b.gsmName} (no value in deployment file)…`
        : `Populating GSM secret ${b.gsmName}…`,
    );
    const proc = Bun.spawn(
      [
        "gcloud",
        "secrets",
        "versions",
        "add",
        b.gsmName,
        "--project",
        projectId,
        "--data-file=-",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(value);
    await proc.stdin.end();
    await proc.exited;
    if (proc.exitCode !== 0) {
      s.stop(`gcloud secrets versions add ${b.gsmName} failed.`);
      log.error((await new Response(proc.stderr).text()).trim());
      return false;
    }
    s.stop(
      isPlaceholder ? `${b.gsmName}: placeholder added.` : `${b.gsmName}: new version added.`,
    );
    if (isPlaceholder) placeholder++;
    else pushed++;
  }
  log.info(`GSM secrets: pushed=${pushed} placeholder=${placeholder}`);
  return true;
}

async function phaseBuildImages(): Promise<boolean> {
  const s = spinner();
  s.start("Building + pushing prod images (api, app, preview)…");
  const root = findRepoRoot();
  const { envPath } = defaultPaths();
  // Pass the deployment file path explicitly so the script doesn't have
  // to re-resolve. Single source of truth lives here.
  const ok = await runWithEnv(
    [resolve(root, "deploy/scripts/build-push-prod.sh")],
    { cwd: root, env: { ...process.env, ENV_FILE: envPath } },
    "build-push-prod.sh",
  );
  s.stop(ok ? "Images pushed." : "Image build/push failed.");
  return ok;
}

async function runWithEnv(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> },
  label: string,
): Promise<boolean> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    log.error(`${label} exited ${proc.exitCode}`);
    return false;
  }
  return true;
}

async function phaseHelmInstall(): Promise<boolean> {
  const s = spinner();
  s.start("helm upgrade --install x1agent…");
  const { envPath, chartDir } = defaultPaths();
  // Image tag matches what build-push-prod.sh used — git short SHA.
  const tag = (await gitRevShort()) || "latest";
  let result;
  try {
    result = render({ envPath, chartDir, imageTag: tag });
  } catch (err) {
    s.stop("values render failed.");
    log.error((err as Error).message);
    return false;
  }
  const ok = await run(
    [
      "helm",
      "upgrade",
      "--install",
      RELEASE,
      chartDir,
      "-f",
      result.valuesPath,
      "--namespace",
      NAMESPACE,
      "--create-namespace",
      "--wait",
      "--timeout",
      "10m",
    ],
    {},
    "helm upgrade x1agent",
  );
  s.stop(ok ? "x1agent chart applied." : "x1agent chart failed.");
  return ok;
}

async function phaseWaitAndReport(baseDomain: string): Promise<void> {
  const s = spinner();
  s.start(
    "Waiting for cert-manager Certificates to become Ready (Let's Encrypt — http-01 usually <1 min, dns-01 1–5 min on first issue)…",
  );
  // Discover the public-TLS Certificates the chart actually rendered
  // instead of hardcoding names — drifts cleanly when previews are
  // disabled (no preview-wildcard Cert) or when new app/api hosts get
  // added. Filter out internal-CA certs (NATS mTLS) — they use the
  // self-signed CA, not Let's Encrypt, and become Ready in seconds.
  const certsToWait = await listPublicCerts();
  if (certsToWait.length === 0) {
    s.stop("No public Certificates found — skipping wait.");
    return;
  }
  // Poll up to 10 minutes for all certs.
  const deadline = Date.now() + 10 * 60_000;
  let allReady = false;
  while (Date.now() < deadline) {
    const states = await Promise.all(certsToWait.map(certReady));
    if (states.every((r) => r)) {
      allReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (allReady) {
    s.stop(`All ${certsToWait.length} certs Ready.`);
  } else {
    s.stop(
      "Cert wait timed out — they may still be provisioning. Check `kubectl -n x1agent get cert` later.",
    );
  }
  note(
    `URLs:\n` +
      `  https://app.${baseDomain}\n` +
      `  https://api.${baseDomain}/health\n\n` +
      `Status:\n` +
      `  kubectl -n x1agent get pods\n` +
      `  kubectl -n x1agent get cert\n` +
      `  kubectl -n x1agent describe ingress x1agent-main`,
    "Live",
  );
}

// ── helpers ────────────────────────────────────────────────────────

async function run(
  args: string[],
  opts: { cwd?: string },
  label: string,
): Promise<boolean> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    log.error(`${label} exited ${proc.exitCode}`);
    return false;
  }
  return true;
}

async function readIngressIp(): Promise<string> {
  const { terraformDir, tfStatePath } = defaultPaths();
  const proc = Bun.spawn(
    ["terraform", "output", "-state=" + tfStatePath, "-raw", "ingress_static_ip"],
    { cwd: terraformDir, stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error("terraform output ingress_static_ip failed");
  }
  return out;
}

async function listPublicCerts(): Promise<string[]> {
  // Returns Certificate names whose issuer is NOT the internal-CA issuer.
  // jsonpath filters at the kubectl side — keeps the install loop free
  // of YAML parsing.
  const proc = Bun.spawn(
    [
      "kubectl",
      "-n",
      NAMESPACE,
      "get",
      "cert",
      "-o",
      "jsonpath={range .items[?(@.spec.issuerRef.name!='x1agent-internal-ca-issuer')]}{.metadata.name}{'\\n'}{end}",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out ? out.split("\n").filter(Boolean) : [];
}

async function certReady(name: string): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "kubectl",
      "-n",
      NAMESPACE,
      "get",
      "cert",
      name,
      "-o",
      "jsonpath={.status.conditions[?(@.type=='Ready')].status}",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out === "True";
}

async function gitRevShort(): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return proc.exitCode === 0 && out ? out : null;
}
