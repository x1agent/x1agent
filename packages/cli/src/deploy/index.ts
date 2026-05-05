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
import { resolve } from "node:path";
import {
  findRepoRoot,
  resolveActiveDeploymentInteractive,
} from "../configure/paths.ts";
import { defaultPaths, render } from "../install/render.ts";
import { runInstallPreflight, reportFailures } from "../install/preflight.ts";
import { printActiveTargetHeader } from "../active-target.ts";

/**
 * Ship code to a configured deployment.
 *
 * Steps, in order:
 *   1. preflight  — gcloud / kubectl / helm / values file present
 *   2. build+push — deploy/scripts/build-push-prod.sh with ENV_FILE +
 *                   IMAGE_TAG. Pushes api / app / sidecar / providers.
 *   3. helm upgrade — pre-upgrade hook Job (templates/migrate-job.yaml)
 *                     runs migrations against in-cluster Postgres before
 *                     the api/app rollout starts.
 *
 * `install` is the structural setup (Terraform, GSM, operator charts,
 * Workload Identity). `deploy` is the ongoing-ship surface — assumes
 * `install` has run at least once.
 *
 * Non-interactive flags (for CI):
 *   --yes        — skip confirms
 *   --tag <sha>  — override IMAGE_TAG (defaults: env INSTALL_IMAGE_TAG
 *                  or `git rev-parse --short HEAD`)
 *   --skip-build — only helm-upgrade an existing tag (rollback flow)
 *
 * The deployment selection respects X1AGENT_DEPLOYMENT env so CI can
 * target a specific install without prompting.
 */

export interface DeployOptions {
  yes: boolean;
  tag?: string;
  skipBuild: boolean;
}

const RELEASE = "x1agent";
const NAMESPACE = "x1agent";

export async function runDeploy(opts: DeployOptions): Promise<boolean> {
  intro("x1agent deploy");

  // Preflight (uses the same checks install does — gcloud, kubectl,
  // helm, deployment file readable, kubectl pointed at the right
  // cluster).
  const pf = await runInstallPreflight();
  if (!pf.ok) {
    reportFailures(pf.failures);
    cancel("Preflight failed.");
    return false;
  }

  const { baseDomain, path: envPath } =
    await resolveActiveDeploymentInteractive();
  printActiveTargetHeader({ baseDomain, envPath });
  const tag =
    opts.tag ||
    process.env.INSTALL_IMAGE_TAG ||
    (await gitRevShort()) ||
    "latest";

  note(
    `Deployment: ${baseDomain}\n` +
      `Tag:        ${tag}\n` +
      `Steps:      ${opts.skipBuild ? "" : "build+push → "}helm upgrade (with pre-upgrade migration)`,
    "Plan",
  );

  if (!opts.yes) {
    const ok = await confirm({
      message: `Deploy ${tag} to ${baseDomain}?`,
      initialValue: true,
    });
    if (isCancel(ok) || !ok) {
      cancel("Cancelled.");
      return false;
    }
  }

  // ── Phase 1: build + push ────────────────────────────────────────
  if (!opts.skipBuild) {
    if (!(await phaseBuildImages(envPath, tag))) return false;
  }

  // ── Phase 2: helm upgrade (migration runs as pre-upgrade hook) ───
  if (!(await phaseHelmUpgrade(envPath, tag))) return false;

  outro(`Deployed ${tag} to ${baseDomain}.`);
  return true;
}

async function phaseBuildImages(
  envPath: string,
  tag: string,
): Promise<boolean> {
  const s = spinner();
  s.start(`Building + pushing images @${tag}…`);
  const root = findRepoRoot();
  const proc = Bun.spawn(
    [resolve(root, "deploy/scripts/build-push-prod.sh")],
    {
      cwd: root,
      env: {
        ...process.env,
        ENV_FILE: envPath,
        IMAGE_TAG: tag,
      } as Record<string, string>,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    s.stop("Image build/push failed.");
    return false;
  }
  s.stop("Images pushed.");
  return true;
}

async function phaseHelmUpgrade(
  envPath: string,
  tag: string,
): Promise<boolean> {
  const { chartDir } = defaultPaths();
  const result = render({ envPath, chartDir, imageTag: tag });

  const s = spinner();
  s.start(
    `helm upgrade x1agent (pre-upgrade migration runs first, then rolling restart of api/app)…`,
  );
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
    { stdout: "inherit", stderr: "inherit" },
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    s.stop("helm upgrade failed.");
    log.error(
      `Inspect: kubectl -n ${NAMESPACE} get jobs,pods\n` +
        `Migration logs: kubectl -n ${NAMESPACE} logs job/x1agent-migrate`,
    );
    return false;
  }
  s.stop("helm upgrade applied.");
  return true;
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

export function parseDeployArgs(argv: string[]): DeployOptions {
  const opts: DeployOptions = { yes: false, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--skip-build") opts.skipBuild = true;
    else if (a === "--tag") {
      opts.tag = argv[++i];
    } else if (a?.startsWith("--tag=")) {
      opts.tag = a.slice("--tag=".length);
    }
  }
  return opts;
}
