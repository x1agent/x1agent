import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  spinner,
  text,
} from "@clack/prompts";
import { existsSync } from "node:fs";
import { defaultPaths, render, renderTerraformVars } from "./render.ts";
import { reportFailures, runInstallPreflight } from "./preflight.ts";
import { selectDeployment } from "./select-deployment.ts";
import { resolveActiveDeploymentInteractive } from "../configure/paths.ts";
import { printActiveTargetHeader } from "../active-target.ts";

/**
 * Install subcommand router. The shape:
 *
 *   install:plan    — preflight + render values.<deployment>.yaml,
 *                     show what helm would install (dry-run --debug).
 *                     No mutation. Safe to run repeatedly.
 *   install:apply   — `helm upgrade --install` against the configured
 *                     cluster. Requires `mise run install:plan` was run
 *                     (i.e. the values file exists).
 *   install:status  — read-only snapshot: ingress IP, managed cert
 *                     status, deployments rolled / not.
 *   install:destroy — `helm uninstall` + namespace delete, with prompt.
 *
 * Terraform is NOT yet wired here. The chart assumes the cluster +
 * Workload Identity + GSM + Artifact Registry already exist (operator
 * provisions those manually for v1). Terraform module is the next slice.
 */

export type InstallAction =
  | "up"
  | "plan"
  | "apply"
  | "status"
  | "destroy"
  | "render-tfvars";

const NAMESPACE = "x1agent";
const RELEASE = "x1agent";

export async function runInstall(action: InstallAction): Promise<boolean> {
  intro(`x1agent install:${action}`);

  // Pick the active deployment up-front (auto if 1, prompt if many).
  // Sets X1AGENT_DEPLOYMENT in env so downstream paths.resolveActiveDeployment
  // returns the chosen one. up.ts also calls preflight inside its own flow,
  // so we skip preflight here when delegating to it.
  const picked = await selectDeployment();
  if (picked === null) {
    cancel(
      "No deployment configured. Run `mise run configure` (deployment mode) first.",
    );
    return false;
  }

  if (action !== "status" && action !== "up") {
    const pf = await runInstallPreflight();
    if (!pf.ok) {
      reportFailures(pf.failures);
      cancel("Preflight failed.");
      return false;
    }
  }

  switch (action) {
    case "up":            return await (await import("./up.ts")).runInstallUp();
    case "plan":          return await doPlan();
    case "apply":         return await doApply();
    case "status":        return await doStatus();
    case "destroy":       return await doDestroy();
    case "render-tfvars": return await doRenderTfvars();
  }
}

// ── render-tfvars ───────────────────────────────────────────────────

async function doRenderTfvars(): Promise<boolean> {
  const { envPath, terraformDir } = defaultPaths();
  try {
    const r = renderTerraformVars({ envPath, terraformDir });
    log.success(`Wrote ${r.tfvarsPath}`);
    outro("Done.");
    return true;
  } catch (err) {
    log.error((err as Error).message);
    return false;
  }
}

// ── plan ────────────────────────────────────────────────────────────

async function doPlan(): Promise<boolean> {
  const { envPath, chartDir } = defaultPaths();

  // Image tag: caller can override via INSTALL_IMAGE_TAG; otherwise
  // git-rev or "latest". Single-tag-for-all-images is intentional.
  const tag =
    process.env.INSTALL_IMAGE_TAG ||
    (await gitRevShort()) ||
    "latest";

  let result;
  try {
    result = render({ envPath, chartDir, imageTag: tag });
  } catch (err) {
    log.error((err as Error).message);
    return false;
  }
  log.success(`Rendered ${result.valuesPath}`);

  const s = spinner();
  s.start("helm template (dry-run)…");
  const proc = Bun.spawn(
    [
      "helm",
      "template",
      RELEASE,
      chartDir,
      "-f",
      result.valuesPath,
      "--namespace",
      NAMESPACE,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    s.stop("helm template failed.");
    log.error((await new Response(proc.stderr).text()).trim());
    return false;
  }
  const out = await new Response(proc.stdout).text();
  s.stop(`Renders ${countDocs(out)} K8s resources for ${result.baseDomain}.`);

  note(
    `Next:  mise run install:apply\n\n` +
      `That will run:\n` +
      `  helm upgrade --install ${RELEASE} ${chartDir} \\\n` +
      `    -f ${result.valuesPath} \\\n` +
      `    --namespace ${NAMESPACE} --create-namespace`,
    "Plan ready",
  );
  outro("Done.");
  return true;
}

// ── apply ───────────────────────────────────────────────────────────

async function doApply(): Promise<boolean> {
  const { chartDir } = defaultPaths();
  const tag =
    process.env.INSTALL_IMAGE_TAG ||
    (await gitRevShort()) ||
    "latest";
  const result = render({
    envPath: defaultPaths().envPath,
    chartDir,
    imageTag: tag,
  });

  if (!existsSync(result.valuesPath)) {
    log.error(
      `Values file ${result.valuesPath} not found. Run \`mise run install:plan\` first.`,
    );
    return false;
  }

  const ok = await confirm({
    message:
      `Install x1agent ${tag} to namespace "${NAMESPACE}" using ${result.valuesPath}? ` +
      `This will create/update K8s resources and start image pulls.`,
    initialValue: false,
  });
  if (isCancel(ok) || !ok) {
    cancel("Cancelled — nothing applied.");
    return false;
  }

  const s = spinner();
  s.start("helm upgrade --install…");
  const proc = Bun.spawn(
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
    { stdout: "pipe", stderr: "pipe" },
  );
  // Stream helm output to terminal so the operator sees progress.
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    s.stop("helm upgrade failed.");
    process.stderr.write(stderrText);
    return false;
  }
  s.stop("helm upgrade applied.");
  process.stdout.write(stdoutText);

  note(
    `Apply complete. Next:\n` +
      `  mise run install:status   — poll until ingress IP + cert ready\n` +
      `  Open https://app.${result.baseDomain} once status is green`,
    "Done",
  );
  outro("Done.");
  return true;
}

// ── status ──────────────────────────────────────────────────────────

async function doStatus(): Promise<boolean> {
  const s = spinner();
  s.start("Reading helm release…");
  const helm = Bun.spawn(
    ["helm", "status", RELEASE, "--namespace", NAMESPACE, "-o", "json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const helmOut = await new Response(helm.stdout).text();
  await helm.exited;
  if (helm.exitCode !== 0) {
    s.stop("No helm release.");
    log.warn(
      `No release "${RELEASE}" in namespace "${NAMESPACE}". ` +
        `Run \`mise run install:apply\` first.`,
    );
    return false;
  }
  s.stop("Helm release found.");

  // Cheap status pull — deployments + ingress IP + managed cert state.
  const deployments = await kubectlJson([
    "get",
    "deploy",
    "-n",
    NAMESPACE,
    "-o",
    "json",
  ]);
  const ingress = await kubectlJson([
    "get",
    "ingress",
    "x1agent-main",
    "-n",
    NAMESPACE,
    "-o",
    "json",
  ]).catch(() => null);
  const cert = await kubectlJson([
    "get",
    "managedcertificate",
    "x1agent-app-api",
    "-n",
    NAMESPACE,
    "-o",
    "json",
  ]).catch(() => null);

  const lines: string[] = [];
  lines.push("Deployments:");
  for (const d of (deployments?.items ?? []) as any[]) {
    const ready = d.status?.readyReplicas ?? 0;
    const desired = d.spec?.replicas ?? 0;
    lines.push(`  ${d.metadata.name}: ${ready}/${desired}`);
  }
  lines.push("");
  if (ingress) {
    const ip =
      ingress.status?.loadBalancer?.ingress?.[0]?.ip ?? "(pending)";
    lines.push(`Ingress IP: ${ip}`);
  }
  if (cert) {
    const status = cert.status?.certificateStatus ?? "(unknown)";
    lines.push(`Managed cert: ${status}`);
    const domStatuses = cert.status?.domainStatus ?? [];
    for (const d of domStatuses) {
      lines.push(`  ${d.domain}: ${d.status}`);
    }
  }
  note(lines.join("\n"), "Status");
  outro("Done.");
  return true;
}

// ── destroy ─────────────────────────────────────────────────────────

async function doDestroy(): Promise<boolean> {
  // Print the active-deployment header so the operator sees which
  // deployment they're about to uninstall. Then require typing the
  // base domain — yes/no prompts get muscle-memory'd through.
  const { baseDomain, path: envPath } =
    await resolveActiveDeploymentInteractive();
  printActiveTargetHeader({ baseDomain, envPath });

  const typed = await text({
    message:
      `This will uninstall x1agent from "${baseDomain}" and delete in-cluster Postgres data.\n` +
      `Type the base domain (${baseDomain}) to confirm:`,
    placeholder: baseDomain,
    validate: (raw) => {
      const t = raw.trim();
      if (!t) return "Required.";
      if (t !== baseDomain)
        return `Doesn't match — expected "${baseDomain}".`;
      return undefined;
    },
  });
  if (isCancel(typed)) {
    cancel("Cancelled.");
    return false;
  }

  const s = spinner();
  s.start("helm uninstall…");
  const proc = Bun.spawn(
    ["helm", "uninstall", RELEASE, "--namespace", NAMESPACE],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    s.stop("helm uninstall failed.");
    log.error((await new Response(proc.stderr).text()).trim());
    return false;
  }
  s.stop("Uninstalled.");
  outro("Done.");
  return true;
}

// ── helpers ─────────────────────────────────────────────────────────

async function gitRevShort(): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return proc.exitCode === 0 && out ? out : null;
}

function countDocs(yaml: string): number {
  return yaml.split(/^---\s*$/m).filter((d) => d.trim()).length;
}

async function kubectlJson(args: string[]): Promise<any> {
  const proc = Bun.spawn(["kubectl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(
      `kubectl ${args.join(" ")} failed: ${(await new Response(proc.stderr).text()).trim()}`,
    );
  }
  return JSON.parse(out);
}
