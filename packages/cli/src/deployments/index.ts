import { existsSync } from "node:fs";
import { EnvFile } from "../configure/env-file.ts";
import {
  installsDir,
  listDeployments,
  deploymentEnvPath,
} from "../configure/paths.ts";

/**
 * Read-only "what's on disk" report. Lists every configured deployment
 * with the bits an operator wants to see at a glance — base domain,
 * cloud target, project, region — without touching any cluster.
 *
 * Surfaced via `mise run deployments`. Use it before running anything
 * destructive to remind yourself which deployments exist.
 */
export function runDeployments(): number {
  const deployments = listDeployments();
  if (deployments.length === 0) {
    process.stderr.write(
      `No deployments configured under ${installsDir()}.\n` +
        `Create one with \`mise run configure:prod\`.\n`,
    );
    return 1;
  }

  const active = process.env.X1AGENT_DEPLOYMENT?.trim();
  process.stdout.write(
    `${deployments.length} deployment${deployments.length === 1 ? "" : "s"} configured:\n\n`,
  );

  for (const baseDomain of deployments) {
    const path = deploymentEnvPath(baseDomain);
    if (!existsSync(path)) continue;
    const env = new EnvFile(path);
    const cloud = env.get("CLOUD_PROVIDER") || "?";
    const project = env.get("GCP_PROJECT_ID") || "—";
    const region = env.get("GCP_REGION") || env.get("CLOUD_ML_REGION") || "—";
    const marker = baseDomain === active ? " ← active" : "";
    process.stdout.write(`  • ${baseDomain}${marker}\n`);
    process.stdout.write(
      `      cloud:   ${cloud}\n` +
        `      project: ${project}\n` +
        `      region:  ${region}\n` +
        `      file:    installs/${baseDomain}.local\n\n`,
    );
  }

  if (!active && deployments.length > 1) {
    process.stdout.write(
      `Set X1AGENT_DEPLOYMENT=<base-domain> to pin one for the current\n` +
        `shell, or pick from the prompt that appears when you run a\n` +
        `prod task interactively.\n`,
    );
  }
  return 0;
}
