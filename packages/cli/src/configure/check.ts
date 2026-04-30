import { existsSync } from "node:fs";
import { EnvFile } from "./env-file.ts";
import { resolveActiveDeployment } from "./paths.ts";

/**
 * Non-interactive validator for the active deployment's install file.
 *
 * Reads `installs/<base-domain>.local` (resolved per
 * paths.resolveActiveDeployment) and asserts that the bare-minimum
 * keys for `mise run terraform:apply` + `install:apply` are present
 * and non-empty. Optional integrations are surfaced as warnings only.
 *
 * Wired as a `depends` of all install/terraform mise tasks so the user
 * gets a friendly "run mise run configure first" instead of an opaque
 * `gcloud` / `helm` failure later.
 *
 * Exit codes:
 *   0 — required keys all present
 *   1 — at least one required key missing/empty (or no deployment file)
 *   2 — usage / unexpected error
 */

const REQUIRED = [
  "CLOUD_PROVIDER",
  "BASE_DOMAIN",
  "JWT_SECRET",
  "API_INTERNAL_TOKEN",
  "PLATFORM_ADMIN_EMAILS",
  "ANTHROPIC_PROVIDER",
];

const REQUIRED_IF_GCP = ["GCP_PROJECT_ID", "GCP_ACCOUNT"];
const REQUIRED_IF_ANTHROPIC_API_KEY = ["ANTHROPIC_API_KEY"];
const REQUIRED_IF_ANTHROPIC_VERTEX = [
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
];

const OPTIONAL = [
  "ALLOWED_DOMAINS",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
];

export function runCheck(): number {
  let envPath: string;
  let baseDomain: string;
  try {
    const active = resolveActiveDeployment();
    envPath = active.path;
    baseDomain = active.baseDomain;
  } catch (err) {
    process.stderr.write(`[configure:check] ${(err as Error).message}\n`);
    return 1;
  }

  if (!existsSync(envPath)) {
    process.stderr.write(
      `[configure:check] ${envPath} missing.\n` +
        `[configure:check] run \`mise run configure\` (deployment mode) first.\n`,
    );
    return 1;
  }

  const env = new EnvFile(envPath);
  const missing: string[] = [];

  for (const k of REQUIRED) {
    if (!env.get(k)) missing.push(k);
  }

  const cloud = env.get("CLOUD_PROVIDER");
  if (cloud === "gcp") {
    for (const k of REQUIRED_IF_GCP) {
      if (!env.get(k)) missing.push(k);
    }
  }

  const anthropic = env.get("ANTHROPIC_PROVIDER");
  if (anthropic === "vertex") {
    if (cloud !== "gcp") {
      missing.push(
        "ANTHROPIC_PROVIDER (vertex requires CLOUD_PROVIDER=gcp)",
      );
    }
    for (const k of REQUIRED_IF_ANTHROPIC_VERTEX) {
      if (!env.get(k)) missing.push(k);
    }
  } else if (anthropic === "api_key") {
    for (const k of REQUIRED_IF_ANTHROPIC_API_KEY) {
      if (!env.get(k)) missing.push(k);
    }
  } else if (anthropic) {
    missing.push(
      `ANTHROPIC_PROVIDER (got '${anthropic}', expected 'api_key' or 'vertex')`,
    );
  }

  if (missing.length > 0) {
    process.stderr.write(
      `[configure:check] ${envPath}\n` +
        `[configure:check] missing required values:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        "\n\n[configure:check] run `mise run configure` to fix.\n",
    );
    return 1;
  }

  const missingOptional = OPTIONAL.filter((k) => !env.get(k));
  if (missingOptional.length > 0) {
    process.stderr.write(
      `[configure:check] (info) optional values not configured:\n` +
        missingOptional.map((k) => `  - ${k}`).join("\n") +
        "\n[configure:check] (info) run `mise run configure` to set them.\n",
    );
  }

  process.stdout.write(`[configure:check] ${baseDomain} ok\n`);
  return 0;
}
