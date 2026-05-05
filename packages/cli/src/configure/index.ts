import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { EnvFile } from "./env-file.ts";
import {
  deploymentEnvPath,
  installsDir,
  listDeployments,
  localEnvPath,
} from "./paths.ts";
import { promptCloudTarget, type CloudTarget } from "./steps/cloud.ts";
import {
  promptOptionalSecrets,
  promptRequiredSecrets,
  type OptionalSecrets,
  type RequiredSecrets,
} from "./steps/secrets.ts";
import { configureGcloud } from "./steps/gcloud.ts";
import {
  promptAnthropic,
  type AnthropicCredentials,
} from "./steps/anthropic.ts";
import { promptProviders, type ProviderChoices } from "./steps/providers.ts";

type ConfigureMode = "local" | "deployment";

export async function runConfigure(): Promise<boolean> {
  intro("x1agent configure");

  const mode = await select<ConfigureMode>({
    message: "What are you configuring?",
    options: [
      {
        value: "deployment",
        label: "A deployment (e.g. x1agent.com on GCP)",
        hint: "writes installs/<base-domain>.local — drives terraform + helm install",
      },
      {
        value: "local",
        label: "Local development (OrbStack)",
        hint: "writes .env.local — drives mise run dev:cold",
      },
    ],
    initialValue: listDeployments().length > 0 ? "deployment" : "local",
  });
  if (isCancel(mode)) {
    cancel("Cancelled.");
    return false;
  }

  return mode === "local"
    ? await runConfigureLocal()
    : await runConfigureDeployment();
}

// ── Local dev ────────────────────────────────────────────────────────

async function runConfigureLocal(): Promise<boolean> {
  const envPath = localEnvPath();
  const env = new EnvFile(envPath);

  note(
    `Local-dev wizard. Captures the small set of OrbStack-only knobs:\n` +
      `  - HOST_HOME_DIR / HOST_CLAUDE_CREDENTIALS_FILE for Claude Max creds\n` +
      `  - AUTH_BYPASS / TEST_USER for the dev sign-in shortcut\n\n` +
      `Everything else (cloud, base domain, GSM secrets, Vertex, integrations)\n` +
      `belongs in a per-deployment file at installs/<base-domain>.local.\n` +
      `Pick "A deployment" mode for that.`,
    "Local development",
  );

  const hostHome = process.env.HOME ?? homedir();
  const hostClaude = `${hostHome}/.x1agent-dev/claude-credentials.json`;

  const wantBypass = await confirm({
    message: "Enable dev auth bypass? (skips Google OAuth on /auth/dev-bypass)",
    initialValue: env.get("AUTH_BYPASS") === "true",
  });
  if (isCancel(wantBypass)) {
    cancel("Cancelled.");
    return false;
  }

  let testUser: string | null = env.get("TEST_USER") || null;
  if (wantBypass) {
    const v = await text({
      message: "Test user email (seeded on first migration when AUTH_BYPASS=true)",
      placeholder: "you@example.com",
      initialValue: testUser ?? "",
      validate: (raw) => {
        const t = raw.trim();
        if (!t) return "Required when AUTH_BYPASS=true.";
        if (!/.+@.+\..+/.test(t)) return "Invalid email.";
        return undefined;
      },
    });
    if (isCancel(v)) {
      cancel("Cancelled.");
      return false;
    }
    testUser = (v as string).trim();
  }

  env.set("HOST_HOME_DIR", hostHome);
  env.set("HOST_CLAUDE_CREDENTIALS_FILE", hostClaude);
  env.set("AUTH_BYPASS", wantBypass ? "true" : "false");
  if (testUser) env.set("TEST_USER", testUser);
  env.save();

  log.success(`Wrote ${envPath}`);
  outro("Done. Next: `mise run dev:cold` to bring the local stack up.");
  return true;
}

// ── Deployment ───────────────────────────────────────────────────────

async function runConfigureDeployment(): Promise<boolean> {
  // Existing deployments + an "add new" sentinel. Operators can edit
  // an existing deployment without remembering its base domain.
  const existing = listDeployments();
  let baseDomainHint: string | undefined;

  if (existing.length > 0) {
    const choice = await select<string>({
      message: "Which deployment?",
      options: [
        ...existing.map((d) => ({ value: d, label: d })),
        { value: "__new__", label: "+ New deployment", hint: "configure a new base domain" },
      ],
      initialValue: existing[0],
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return false;
    }
    if (choice !== "__new__") baseDomainHint = choice;
  }

  // Need the base domain BEFORE everything else so we know which file
  // to read existing values from. When the user picked an existing
  // deployment from the menu, baseDomainHint is set and we ARE editing
  // it — typing a different domain here would create a NEW file.
  // When they picked "+ New deployment", baseDomainHint is undefined
  // and the typed value must NOT collide with an existing file (else
  // we'd silently turn a "new" wizard run into an edit of someone
  // else's deployment).
  const isEditing = !!baseDomainHint;
  const baseDomainAnswer = await text({
    message: isEditing
      ? `Base domain (editing ${baseDomainHint})`
      : "Base domain for this new deployment",
    placeholder: "x1agent.com",
    initialValue: baseDomainHint ?? "",
    validate: (raw) => {
      const t = raw.trim();
      if (!t) return "Required. The deployment file is named after this.";
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(t))
        return "Looks like an invalid domain — expected something like x1agent.com.";
      // No-clobber guard: when "+ New deployment" was picked, refuse to
      // proceed if the typed domain already has a file. Forces explicit
      // intent — operator must restart and pick "edit" to modify.
      if (!isEditing && existing.includes(t)) {
        return `installs/${t}.local already exists. Cancel and pick "${t}" from the deployment list to edit, or pick a different base domain.`;
      }
      return undefined;
    },
  });
  if (isCancel(baseDomainAnswer)) {
    cancel("Cancelled.");
    return false;
  }
  const baseDomain = (baseDomainAnswer as string).trim();
  const envPath = deploymentEnvPath(baseDomain);
  mkdirSync(dirname(envPath), { recursive: true });
  const env = new EnvFile(envPath);

  note(
    `Captures the install-time config for ${baseDomain}:\n` +
      `  - cloud target + GCP bindings\n` +
      `  - Anthropic credential source (Vertex or API key)\n` +
      `  - secrets (JWT, admins, optional integrations)\n\n` +
      `Lands in:\n` +
      `  ${envPath}    (gitignored)\n` +
      `  ~/.config/gcloud/configurations/config_x1agent  (only if GCP)`,
    "What this does",
  );

  // ── Cloud target ─────────────────────────────────────────────────
  const cloud = await promptCloudTarget({
    provider: env.get("CLOUD_PROVIDER") as CloudTarget["provider"] | undefined,
    baseDomain: env.get("BASE_DOMAIN") || baseDomain,
    gcpProjectId: env.get("GCP_PROJECT_ID"),
    gcpAccount: env.get("GCP_ACCOUNT"),
  });
  if (!cloud) {
    cancel("Cancelled — nothing written.");
    return false;
  }
  // Force the cloud step's baseDomain to match the file name to avoid
  // the file/value drift footgun.
  cloud.baseDomain = baseDomain;

  // ── Anthropic credentials ────────────────────────────────────────
  const anthropic = await promptAnthropic(
    {
      provider: env.get("ANTHROPIC_PROVIDER") as
        | AnthropicCredentials["provider"]
        | undefined,
      apiKey: env.get("ANTHROPIC_API_KEY"),
      vertexRegion: env.get("CLOUD_ML_REGION"),
      vertexProjectId: env.get("ANTHROPIC_VERTEX_PROJECT_ID"),
    },
    cloud.provider,
    cloud.gcpProjectId,
  );
  if (!anthropic) {
    cancel("Cancelled — nothing written.");
    return false;
  }

  // ── Providers ────────────────────────────────────────────────────
  // Capability gating: the helm chart writes PROVIDER_GRAPH /
  // PROVIDER_VECTOR into the api Deployment env; the api echoes them
  // through GET /api/capabilities; the frontend hides Collections etc.
  // when the matching provider is "none".
  const providers = await promptProviders({
    graph: env.get("PROVIDER_GRAPH"),
    vector: env.get("PROVIDER_VECTOR"),
  });
  if (!providers) {
    cancel("Cancelled — nothing written.");
    return false;
  }

  // ── Required secrets ─────────────────────────────────────────────
  const required = await promptRequiredSecrets({
    JWT_SECRET: env.get("JWT_SECRET"),
    API_INTERNAL_TOKEN: env.get("API_INTERNAL_TOKEN"),
    PLATFORM_ADMIN_EMAILS: env.get("PLATFORM_ADMIN_EMAILS"),
  });
  if (!required) {
    cancel("Cancelled — nothing written.");
    return false;
  }

  // ── Optional secrets ─────────────────────────────────────────────
  const optional = await promptOptionalSecrets({
    ALLOWED_DOMAINS: env.get("ALLOWED_DOMAINS"),
    GOOGLE_OAUTH_CLIENT_ID: env.get("GOOGLE_OAUTH_CLIENT_ID"),
    GOOGLE_OAUTH_CLIENT_SECRET: env.get("GOOGLE_OAUTH_CLIENT_SECRET"),
    SLACK_BOT_TOKEN: env.get("SLACK_BOT_TOKEN"),
    GITHUB_APP_ID: env.get("GITHUB_APP_ID"),
    GITHUB_APP_SLUG: env.get("GITHUB_APP_SLUG"),
    GITHUB_APP_CLIENT_ID: env.get("GITHUB_APP_CLIENT_ID"),
    GITHUB_APP_CLIENT_SECRET: env.get("GITHUB_APP_CLIENT_SECRET"),
    GITHUB_APP_PRIVATE_KEY: env.get("GITHUB_APP_PRIVATE_KEY"),
    GITHUB_APP_WEBHOOK_SECRET: env.get("GITHUB_APP_WEBHOOK_SECRET"),
  });
  if (!optional) {
    cancel("Cancelled — nothing written.");
    return false;
  }

  // ── Summary + confirm ────────────────────────────────────────────
  const willChange = summarizeChanges(
    env,
    cloud,
    anthropic,
    providers,
    required,
    optional,
  );
  if (willChange.length === 0) {
    note("No changes — everything was already set as you confirmed.", "Nothing to write");
    outro("Done.");
    return true;
  }
  note(willChange.join("\n"), "About to write");

  const ok = await confirm({
    message: `Write the above to ${envPath}?`,
    initialValue: true,
  });
  if (isCancel(ok) || !ok) {
    cancel("Cancelled — nothing written.");
    return false;
  }

  // ── Write ────────────────────────────────────────────────────────
  env.set("CLOUD_PROVIDER", cloud.provider);
  env.set("BASE_DOMAIN", cloud.baseDomain);
  if (cloud.provider === "gcp") {
    env.set("GCP_PROJECT_ID", cloud.gcpProjectId!);
    env.set("GCP_ACCOUNT", cloud.gcpAccount!);
  } else {
    env.unset("GCP_PROJECT_ID");
    env.unset("GCP_ACCOUNT");
  }
  env.set("ANTHROPIC_PROVIDER", anthropic.provider);
  if (anthropic.provider === "vertex") {
    env.set("CLOUD_ML_REGION", anthropic.vertexRegion!);
    env.set("ANTHROPIC_VERTEX_PROJECT_ID", anthropic.vertexProjectId!);
    env.unset("ANTHROPIC_API_KEY");
  } else {
    if (anthropic.apiKey) env.set("ANTHROPIC_API_KEY", anthropic.apiKey);
    env.unset("CLOUD_ML_REGION");
    env.unset("ANTHROPIC_VERTEX_PROJECT_ID");
  }
  // PROVIDER_<DOMAIN>=none keeps the variable explicit in the env
  // file rather than absent, so a `grep PROVIDER_ install.local`
  // shows the gating decision without ambiguity.
  env.set("PROVIDER_GRAPH", providers.graph || "none");
  env.set("PROVIDER_VECTOR", providers.vector || "none");
  for (const [k, v] of Object.entries(required)) env.set(k, v);
  for (const [k, v] of Object.entries(optional)) {
    if (v === undefined || v === "") continue;
    env.set(k, v);
  }
  env.save();
  log.success(`Wrote ${envPath}`);

  // ── gcloud configuration ─────────────────────────────────────────
  if (cloud.provider === "gcp") {
    try {
      await configureGcloud({
        account: cloud.gcpAccount!,
        projectId: cloud.gcpProjectId!,
      });
    } catch (err) {
      log.error(
        `gcloud configuration failed: ${(err as Error).message}\n` +
          `${envPath} was still written. Re-run \`mise run configure\` after fixing.`,
      );
      return false;
    }
  }

  const next =
    listDeployments().length > 1
      ? `\nMultiple deployments exist in ${installsDir()} — set\n` +
        `X1AGENT_DEPLOYMENT=${baseDomain} when running prod tasks (or pick from\n` +
        `the prompt that appears when more than one is configured).`
      : "";
  outro(
    `Done. Next:\n` +
      `  mise run terraform:prod:init           (one-time per machine)\n` +
      `  mise run terraform:prod:apply:cluster  (provision GCP infra)${next}\n` +
      `  mise run install:prod                  (full one-shot install)`,
  );
  return true;
}

function summarizeChanges(
  env: EnvFile,
  cloud: CloudTarget,
  anthropic: AnthropicCredentials,
  providers: ProviderChoices,
  required: RequiredSecrets,
  optional: OptionalSecrets,
): string[] {
  const lines: string[] = [];
  const want: Record<string, string | undefined> = {
    CLOUD_PROVIDER: cloud.provider,
    BASE_DOMAIN: cloud.baseDomain,
    GCP_PROJECT_ID: cloud.gcpProjectId,
    GCP_ACCOUNT: cloud.gcpAccount,
    ANTHROPIC_PROVIDER: anthropic.provider,
    PROVIDER_GRAPH: providers.graph || "none",
    PROVIDER_VECTOR: providers.vector || "none",
    ...(anthropic.provider === "vertex"
      ? {
          CLOUD_ML_REGION: anthropic.vertexRegion,
          ANTHROPIC_VERTEX_PROJECT_ID: anthropic.vertexProjectId,
        }
      : { ANTHROPIC_API_KEY: anthropic.apiKey }),
    ...required,
    ...optional,
  };
  const SECRET_KEYS = new Set([
    "JWT_SECRET",
    "API_INTERNAL_TOKEN",
    "ANTHROPIC_API_KEY",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "SLACK_BOT_TOKEN",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_WEBHOOK_SECRET",
  ]);
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined || v === "") continue;
    const cur = env.get(k);
    if (cur === v) continue;
    const display = SECRET_KEYS.has(k) ? "(masked)" : v;
    if (cur === undefined) lines.push(`  + ${k} = ${display}`);
    else lines.push(`  ~ ${k} = ${display}`);
  }
  if (cloud.provider === "local") {
    if (env.has("GCP_PROJECT_ID")) lines.push(`  - GCP_PROJECT_ID`);
    if (env.has("GCP_ACCOUNT")) lines.push(`  - GCP_ACCOUNT`);
  }
  if (anthropic.provider === "vertex" && env.has("ANTHROPIC_API_KEY")) {
    lines.push(`  - ANTHROPIC_API_KEY (using Vertex)`);
  } else if (anthropic.provider === "api_key") {
    if (env.has("CLOUD_ML_REGION")) lines.push(`  - CLOUD_ML_REGION`);
    if (env.has("ANTHROPIC_VERTEX_PROJECT_ID"))
      lines.push(`  - ANTHROPIC_VERTEX_PROJECT_ID`);
  }
  return lines;
}
