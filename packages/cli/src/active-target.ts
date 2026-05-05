import { EnvFile } from "./configure/env-file.ts";

/**
 * Header line printed at the top of every cluster-touching prod task
 * — install, deploy, logs, psql, etc. Surfaces the resolved deployment
 * before any prompt or mutation so the operator always sees where the
 * command is about to act, even if they forgot which X1AGENT_DEPLOYMENT
 * was exported in this shell.
 *
 * Format (intentionally compact, prints to stderr so it never mingles
 * with command stdout that might be piped):
 *
 *   → target:    x1agent.com (gcp · us-central1 · project x1agent)
 *     config:    installs/x1agent.com.local
 */
export function printActiveTargetHeader(input: {
  baseDomain: string;
  envPath: string;
}): void {
  const env = new EnvFile(input.envPath);
  const cloud = env.get("CLOUD_PROVIDER") || "?";
  const project = env.get("GCP_PROJECT_ID");
  const region = env.get("GCP_REGION") || env.get("CLOUD_ML_REGION");

  const bits = [cloud];
  if (region) bits.push(region);
  if (project) bits.push(`project ${project}`);

  process.stderr.write(
    `→ target:    ${input.baseDomain} (${bits.join(" · ")})\n` +
      `  config:    ${shortenForDisplay(input.envPath)}\n`,
  );
}

function shortenForDisplay(absolute: string): string {
  // Show the path relative to the repo root if we can — easier to scan
  // than a long absolute path. Falls back to the absolute string if
  // resolution fails.
  const marker = "/installs/";
  const idx = absolute.indexOf(marker);
  if (idx === -1) return absolute;
  return absolute.slice(idx + 1); // strip the leading "/"
}
