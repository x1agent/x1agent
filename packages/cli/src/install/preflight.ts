import { log, spinner } from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolveActiveDeployment } from "../configure/paths.ts";

/**
 * Pre-install checks. Each is read-only — no cluster, GCP, or
 * filesystem mutation. A single failing check returns false; caller
 * aborts.
 */

interface PreflightResult {
  ok: boolean;
  failures: string[];
}

export async function runInstallPreflight(): Promise<PreflightResult> {
  const failures: string[] = [];
  const s = spinner();

  s.start("Checking required tools…");
  const need = ["helm", "kubectl", "gcloud"];
  for (const tool of need) {
    if (!(await onPath(tool))) {
      failures.push(
        `${tool} not found on PATH. Install it before re-running.`,
      );
    }
  }
  s.stop(failures.length === 0 ? "Tools present." : "Tool checks failed.");
  if (failures.length > 0) return { ok: false, failures };

  s.start("Checking gcloud auth state…");
  const accts = await listGcloudAccounts();
  if (accts.length === 0) {
    s.stop("No gcloud auth.");
    failures.push(
      "No gcloud accounts authenticated. Run `gcloud auth login` first.",
    );
    return { ok: false, failures };
  }
  s.stop(`Active gcloud account(s): ${accts.join(", ")}`);

  s.start("Checking active deployment…");
  try {
    const { baseDomain, path } = resolveActiveDeployment();
    if (!existsSync(path)) {
      s.stop("Deployment file missing.");
      failures.push(
        `${path} missing. Run \`mise run configure\` (deployment mode) first.`,
      );
      return { ok: false, failures };
    }
    s.stop(`Active deployment: ${baseDomain}`);
  } catch (err) {
    s.stop("No deployment configured.");
    failures.push((err as Error).message);
    return { ok: false, failures };
  }

  return { ok: true, failures };
}

async function onPath(tool: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", tool], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function listGcloudAccounts(): Promise<string[]> {
  const proc = Bun.spawn(
    ["gcloud", "auth", "list", "--format=value(account)"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (proc.exitCode !== 0) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function reportFailures(failures: string[]): void {
  for (const f of failures) log.error(f);
}
