import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EnvFile } from "../configure/env-file.ts";
import { resolveActiveDeploymentInteractive } from "../configure/paths.ts";
import { printActiveTargetHeader } from "../active-target.ts";

/**
 * `mise run logs <component> [-- <kubectl-args>]`
 *
 * Thin wrapper around `kubectl logs` that points at the active
 * deployment's cluster (read from installs/<base-domain>.local) so the
 * operator never has to manage KUBECONFIG by hand. The mise task
 * unsets the OrbStack KUBECONFIG override before invoking us; we
 * read the install file, ensure gcloud creds are loaded for the
 * right project + region + cluster, then exec kubectl with sensible
 * defaults (namespace = x1agent, --tail=200, --since=10m, follow=false).
 *
 * Components map to label selectors so the user types
 *   mise run logs api
 * instead of guessing pod names.
 */

type Component =
  | "api"
  | "app"
  | "agent"
  | "graph"
  | "preview"
  | "messaging"
  | "all";

const SELECTORS: Record<Exclude<Component, "all">, string> = {
  api: "app.kubernetes.io/component=api",
  app: "app.kubernetes.io/component=app",
  agent: "app=x1agent,component=agent-session",
  graph: "app.kubernetes.io/component=graph-surrealdb",
  preview: "app.kubernetes.io/component=preview-provider",
  messaging: "app.kubernetes.io/component=messaging-slack",
};

interface ParsedArgs {
  component: Component;
  follow: boolean;
  tail: number;
  since: string | null;
  grep: string | null;
  container: string | null;
  /** Anything after `--` is forwarded verbatim to kubectl. */
  passthrough: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    component: "api",
    follow: false,
    tail: 200,
    since: null,
    grep: null,
    container: null,
    passthrough: [],
  };
  // Split on `--` so passthrough flags don't collide with ours.
  const dashIdx = argv.indexOf("--");
  const ours = dashIdx === -1 ? argv : argv.slice(0, dashIdx);
  out.passthrough = dashIdx === -1 ? [] : argv.slice(dashIdx + 1);

  // First positional (if any) is the component.
  const positional = ours.filter((a) => !a.startsWith("-"));
  if (positional[0]) out.component = positional[0] as Component;

  for (let i = 0; i < ours.length; i++) {
    const a = ours[i]!;
    if (a === "-f" || a === "--follow") out.follow = true;
    else if (a === "--tail") out.tail = Number(ours[++i]) || out.tail;
    else if (a.startsWith("--tail=")) out.tail = Number(a.slice(7)) || out.tail;
    else if (a === "--since") out.since = ours[++i] ?? null;
    else if (a.startsWith("--since=")) out.since = a.slice(8);
    else if (a === "--grep") out.grep = ours[++i] ?? null;
    else if (a.startsWith("--grep=")) out.grep = a.slice(7);
    else if (a === "-c" || a === "--container") out.container = ours[++i] ?? null;
    else if (a.startsWith("--container="))
      out.container = a.slice("--container=".length);
  }
  return out;
}

function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", env });
    p.on("exit", (code) => resolve(code ?? 1));
    p.on("error", (err) => {
      process.stderr.write(`[logs] spawn ${cmd} failed: ${err.message}\n`);
      resolve(1);
    });
  });
}

function execCapture(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => (stdout += d.toString()));
    p.stderr?.on("data", (d) => (stderr += d.toString()));
    p.on("exit", (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    );
  });
}

export async function runLogs(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  // Resolve the active install file → cluster context. Interactive
  // resolver: prompts when multiple deployments exist + stdin is a
  // TTY; falls back to throwing in CI.
  let baseDomain: string;
  let envPath: string;
  try {
    const resolved = await resolveActiveDeploymentInteractive();
    baseDomain = resolved.baseDomain;
    envPath = resolved.path;
  } catch (err) {
    process.stderr.write(`[logs] ${(err as Error).message}\n`);
    return 1;
  }
  if (!existsSync(envPath)) {
    process.stderr.write(
      `[logs] ${envPath} missing. Run \`mise run configure:prod\` first.\n`,
    );
    return 1;
  }
  printActiveTargetHeader({ baseDomain, envPath });
  const env = new EnvFile(envPath);
  const cloud = env.get("CLOUD_PROVIDER");
  const projectId = env.get("GCP_PROJECT_ID");
  const region = env.get("GCP_REGION") || "us-central1";
  const cluster = env.get("GKE_CLUSTER_NAME") || "x1agent";
  const namespace = env.get("K8S_NAMESPACE") || "x1agent";

  if (cloud !== "gcp") {
    process.stderr.write(
      `[logs] only CLOUD_PROVIDER=gcp is wired today (got '${cloud}'). PRs welcome for AWS/Azure.\n`,
    );
    return 1;
  }
  if (!projectId) {
    process.stderr.write(
      `[logs] GCP_PROJECT_ID missing in ${envPath}. Run \`mise run configure\`.\n`,
    );
    return 1;
  }

  // Use a deployment-specific kubeconfig path so we never collide with
  // OrbStack or with the user's default ~/.kube/config.
  const kubeconfigPath = join(
    homedir(),
    ".kube",
    `config.x1agent.${projectId}`,
  );
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KUBECONFIG: kubeconfigPath,
  };

  // Refresh credentials. Cheap when up to date; idempotent.
  if (!existsSync(kubeconfigPath)) {
    process.stderr.write(
      `[logs] fetching cluster credentials → ${kubeconfigPath}\n`,
    );
  }
  const creds = await execCapture(
    "gcloud",
    [
      "container",
      "clusters",
      "get-credentials",
      cluster,
      "--region",
      region,
      "--project",
      projectId,
    ],
    baseEnv,
  );
  if (creds.code !== 0) {
    process.stderr.write(
      `[logs] gcloud get-credentials failed:\n${creds.stderr}`,
    );
    return creds.code;
  }

  const args = parseArgs(argv);

  // Build kubectl args.
  const kubectlArgs: string[] = ["logs", "-n", namespace];

  if (args.component === "all") {
    kubectlArgs.push("-l", "app.kubernetes.io/part-of=x1agent");
  } else {
    const sel = SELECTORS[args.component];
    if (!sel) {
      process.stderr.write(
        `[logs] unknown component '${args.component}'. Known: ${Object.keys(SELECTORS).join(", ")}, all\n`,
      );
      return 1;
    }
    kubectlArgs.push("-l", sel);
  }

  kubectlArgs.push(`--tail=${args.tail}`);
  if (args.since) kubectlArgs.push(`--since=${args.since}`);
  if (args.follow) kubectlArgs.push("-f");
  if (args.container) kubectlArgs.push(`--container=${args.container}`);

  // Show pod name on each line so multi-pod components stay legible.
  kubectlArgs.push("--prefix");

  // Forward operator passthrough flags last so they win on conflict.
  kubectlArgs.push(...args.passthrough);

  process.stderr.write(
    `[logs] cluster=${cluster} ns=${namespace} component=${args.component}\n`,
  );

  if (!args.grep) {
    return exec("kubectl", kubectlArgs, baseEnv);
  }

  // Pipe through grep without losing the pod prefix.
  const r = await execCapture("kubectl", kubectlArgs, baseEnv);
  process.stderr.write(r.stderr);
  if (r.code !== 0) return r.code;
  const re = new RegExp(args.grep, "i");
  const matched = r.stdout
    .split("\n")
    .filter((l) => re.test(l))
    .join("\n");
  process.stdout.write(matched + (matched.endsWith("\n") ? "" : "\n"));
  return 0;
}

function printHelp() {
  process.stdout.write(`x1 logs — kubectl logs against the active deployment

Usage:
  mise run logs [<component>] [flags] [-- <kubectl-passthrough>]

Components:
  api          The Hono API server (default)
  app          The Astro/React frontend
  agent        Active agent session pods
  graph        SurrealDB graph provider
  preview      Preview provider
  messaging    Slack messaging provider
  all          Every pod labelled part-of=x1agent

Flags:
  -f, --follow      Stream new lines (kubectl -f).
  --tail <n>        Lines per pod (default 200).
  --since <dur>     Only logs newer than e.g. 10m, 1h, 2025-01-01T00:00:00Z.
  --grep <pattern>  Filter output through case-insensitive regex (incompatible with -f).

Examples:
  mise run logs api
  mise run logs api --grep sentry
  mise run logs api -f --tail 50
  mise run logs all --since 5m -- --max-log-requests 12
`);
}
