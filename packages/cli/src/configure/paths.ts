import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * File-path resolution for configure + install commands.
 *
 * Two destinations exist:
 *   - LOCAL DEV     → .env.local at the repo root
 *   - DEPLOYMENT    → installs/<base-domain>.local at the repo root
 *
 * The split exists so a contributor running `mise run dev:cold` never
 * sees production-deployment values and vice versa. See
 * `installs/example.local` and `.env.example` for what belongs where.
 */

export function findRepoRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, ".env.example"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function localEnvPath(): string {
  return resolve(findRepoRoot(), ".env.local");
}

export function installsDir(): string {
  return resolve(findRepoRoot(), "installs");
}

export function deploymentEnvPath(baseDomain: string): string {
  return resolve(installsDir(), `${baseDomain}.local`);
}

/**
 * List existing deployment files. Excludes the `example.local` template
 * + any file that doesn't match `<host>.local`.
 */
export function listDeployments(): string[] {
  const dir = installsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".local") && f !== "example.local")
    .map((f) => f.slice(0, -".local".length))
    .sort();
}

/**
 * Resolve which deployment file an install/terraform task should read.
 * Resolution order:
 *   1. X1AGENT_DEPLOYMENT env var (explicit)
 *   2. If exactly one deployment file exists, use it (zero-config common case)
 *   3. Throw with a helpful message
 *
 * Throws because the alternative — silently picking the "wrong"
 * deployment — would be a destructive action against the wrong cluster.
 */
export function resolveActiveDeployment(): { baseDomain: string; path: string } {
  const explicit = process.env.X1AGENT_DEPLOYMENT?.trim();
  if (explicit) {
    const path = deploymentEnvPath(explicit);
    if (!existsSync(path)) {
      throw new Error(
        `X1AGENT_DEPLOYMENT=${explicit} but ${path} does not exist.\n` +
          `Run \`mise run configure\` and pick "A deployment" (use base domain: ${explicit}).`,
      );
    }
    return { baseDomain: explicit, path };
  }

  const deployments = listDeployments();
  if (deployments.length === 0) {
    throw new Error(
      `No deployment files found in ${installsDir()}.\n` +
        `Run \`mise run configure\` and pick "A deployment" first.`,
    );
  }
  if (deployments.length > 1) {
    throw new Error(
      `Multiple deployments found in ${installsDir()}:\n` +
        deployments.map((d) => `  - ${d}`).join("\n") +
        `\n\nSet X1AGENT_DEPLOYMENT=<base-domain> to pick one.`,
    );
  }
  const baseDomain = deployments[0]!;
  return { baseDomain, path: deploymentEnvPath(baseDomain) };
}
