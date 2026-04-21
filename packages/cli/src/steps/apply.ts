import { log, spinner } from "@clack/prompts";
import { homedir } from "node:os";
import type { AdminCredentials } from "./admin.ts";
import type { AnthropicSource } from "./anthropic.ts";

const KUBECONFIG = `${homedir()}/.orbstack/k8s/config.yml`;
const SECRETS_NAMESPACE = "x1agent-secrets";
const APP_NAMESPACE = "x1agent";

interface ApplyInput {
  admin: AdminCredentials;
  anthropic: AnthropicSource;
  openai: string | null;
  githubPat: string | null;
}

/**
 * Apply everything the wizard collected to the cluster. Each helper
 * shells out to `kubectl` rather than going through a K8s client
 * library — we run few enough calls here that the extra dep isn't
 * worth it. Shell errors bubble up; the wizard surfaces them with a
 * short message and exits.
 *
 * All writes are idempotent:
 *   - namespaces use `apply --dry-run=client -o yaml | apply`
 *   - Secrets are replaced in place if they already exist
 *   - ESO is installed via `helm upgrade --install`
 *
 * Re-running the wizard safely overwrites the previous generation.
 */
export async function applyAll(input: ApplyInput): Promise<void> {
  const s = spinner();

  s.start("Creating namespaces…");
  await kubectlApply(namespaceManifest(APP_NAMESPACE));
  await kubectlApply(namespaceManifest(SECRETS_NAMESPACE));
  s.stop("Namespaces ready.");

  s.start("Installing External Secrets Operator…");
  await installEso();
  s.stop("External Secrets Operator ready.");

  s.start("Writing secrets…");
  // Anthropic key — only api_key here, claude_folder was removed per
  // the ToS policy. Left as a switch so future credential kinds slot
  // in cleanly.
  if (input.anthropic.kind === "api_key") {
    await writeSecret("anthropic-api-key", input.anthropic.value);
  }
  if (input.openai) {
    await writeSecret("openai-api-key", input.openai);
  }
  if (input.githubPat) {
    await writeSecret("github-pat", input.githubPat);
  }
  s.stop("Secrets written.");

  s.start("Seeding admin user…");
  // TODO: wire to the api's seed script once it supports password
  // bootstrap. For now this is a no-op — the web UI's password-auth
  // path is wired but the seed step is still the existing dev-bypass
  // flow. Leaving a stub so the wizard shape is stable.
  log.warn(
    `Admin seed is a placeholder for now — sign in via dev-bypass at first`,
  );
  s.stop("Admin step skipped (placeholder).");
}

// ── helpers ──────────────────────────────────────────────────────

function namespaceManifest(name: string): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${name}
  labels:
    x1agent.io/managed-by: quickstart
`;
}

async function kubectlApply(manifest: string): Promise<void> {
  const proc = Bun.spawn(["kubectl", "apply", "-f", "-"], {
    env: { ...process.env, KUBECONFIG },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(manifest);
  await proc.stdin.end();
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`kubectl apply failed: ${err.trim()}`);
  }
}

/**
 * Install ESO via helm. Idempotent — `helm upgrade --install` creates
 * on first run, upgrades on subsequent runs. --skip-crds protects the
 * CRD version from rolling backwards in mid-flight upgrades; for the
 * first install we rely on `--set installCRDs=true` in the values.
 */
async function installEso(): Promise<void> {
  // Add the repo (no-op if already added).
  await runOrThrow([
    "helm",
    "repo",
    "add",
    "external-secrets",
    "https://charts.external-secrets.io",
  ]).catch(() => {
    /* helm repo add is noisy when repo exists; swallow */
  });
  await runOrThrow(["helm", "repo", "update"]);
  await runOrThrow([
    "helm",
    "upgrade",
    "--install",
    "external-secrets",
    "external-secrets/external-secrets",
    "--namespace",
    "external-secrets",
    "--create-namespace",
    "--set",
    "installCRDs=true",
    "--wait",
    "--timeout",
    "120s",
  ]);
}

/**
 * Write a secret value into a K8s Secret under the privileged
 * x1agent-secrets namespace. `kubectl create secret --dry-run | apply`
 * is the idiomatic idempotent shape — creates on first run,
 * replaces on subsequent runs.
 *
 * Value is passed via stdin to avoid it ever appearing in a process
 * argv. Secrets are kept to a single key `value` by convention so the
 * ExternalSecret consumer always knows where to look.
 */
async function writeSecret(name: string, value: string): Promise<void> {
  // Stage 1: render the Secret manifest via kubectl create --dry-run,
  // feeding the value through stdin with --from-file=value=/dev/stdin.
  const render = Bun.spawn(
    [
      "kubectl",
      "create",
      "secret",
      "generic",
      `x1-secret-${name}`,
      "--namespace",
      SECRETS_NAMESPACE,
      "--from-file=value=/dev/stdin",
      "--dry-run=client",
      "-o",
      "yaml",
    ],
    {
      env: { ...process.env, KUBECONFIG },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  render.stdin.write(value);
  await render.stdin.end();
  const manifest = await new Response(render.stdout).text();
  await render.exited;
  if (render.exitCode !== 0) {
    const err = await new Response(render.stderr).text();
    throw new Error(`render secret '${name}' failed: ${err.trim()}`);
  }

  // Stage 2: apply the manifest.
  const apply = Bun.spawn(["kubectl", "apply", "-f", "-"], {
    env: { ...process.env, KUBECONFIG },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  apply.stdin.write(manifest);
  await apply.stdin.end();
  await apply.exited;
  if (apply.exitCode !== 0) {
    const err = await new Response(apply.stderr).text();
    throw new Error(`apply secret '${name}' failed: ${err.trim()}`);
  }
}

async function runOrThrow(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, KUBECONFIG },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(" ")} failed: ${err.trim()}`);
  }
  return out;
}
