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
 *   1. X1AGENT_DEPLOYMENT env var (explicit, scriptable, CI-friendly)
 *   2. If exactly one deployment file exists, use it (zero-config common case)
 *   3. Throw with the list of options. Throws because the alternative —
 *      silently picking the "wrong" deployment — would be a destructive
 *      action against the wrong cluster.
 *
 * For interactive ambiguity-prompting use `resolveActiveDeploymentInteractive`
 * — it falls through to a select prompt before throwing when stdin is a TTY.
 */
export function resolveActiveDeployment(): { baseDomain: string; path: string } {
  const explicit = process.env.X1AGENT_DEPLOYMENT?.trim();
  if (explicit) {
    const path = deploymentEnvPath(explicit);
    if (!existsSync(path)) {
      throw new Error(
        `X1AGENT_DEPLOYMENT=${explicit} but ${path} does not exist.\n` +
          `Run \`mise run configure:prod\` and pick "+ New deployment" (use base domain: ${explicit}).`,
      );
    }
    return { baseDomain: explicit, path };
  }

  const deployments = listDeployments();
  if (deployments.length === 0) {
    throw new Error(
      `No deployment files found in ${installsDir()}.\n` +
        `Run \`mise run configure:prod\` to create one.`,
    );
  }
  if (deployments.length > 1) {
    throw new Error(
      `Multiple deployments found in ${installsDir()}:\n` +
        deployments.map((d) => `  - ${d}`).join("\n") +
        `\n\nSet X1AGENT_DEPLOYMENT=<base-domain> to pick one, or run the\n` +
        `command from a TTY where the wizard can prompt you.`,
    );
  }
  const baseDomain = deployments[0]!;
  return { baseDomain, path: deploymentEnvPath(baseDomain) };
}

/**
 * Same as `resolveActiveDeployment`, except: when there are multiple
 * deployments AND stdin is a TTY AND no env var is set, prompt the
 * operator to pick. CI / non-TTY behavior is unchanged (fail-fast with
 * the list).
 *
 * The clack `select` prompt is dynamically imported so this module
 * stays cheap to require from non-CLI contexts (the install fixture
 * file in tests pulls it in to assert paths).
 */
export async function resolveActiveDeploymentInteractive(): Promise<{
  baseDomain: string;
  path: string;
}> {
  const explicit = process.env.X1AGENT_DEPLOYMENT?.trim();
  if (explicit) return resolveActiveDeployment();

  const deployments = listDeployments();
  if (deployments.length <= 1) return resolveActiveDeployment();

  // Multiple. Prompt if we have a TTY; else fall through to the
  // throwing resolver so CI fails loudly.
  if (!process.stdin.isTTY) return resolveActiveDeployment();

  const { isCancel, select, cancel } = await import("@clack/prompts");
  const choice = await select<string>({
    message: "Multiple deployments configured — pick one for this command:",
    options: deployments.map((d) => ({ value: d, label: d })),
  });
  if (isCancel(choice)) {
    cancel("No deployment selected.");
    throw new Error("aborted: no deployment selected");
  }
  const baseDomain = choice as string;
  return { baseDomain, path: deploymentEnvPath(baseDomain) };
}
