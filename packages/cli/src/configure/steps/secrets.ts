import { confirm, isCancel, log, password, text } from "@clack/prompts";
import { randomBytes } from "node:crypto";

export interface RequiredSecrets {
  JWT_SECRET: string;
  API_INTERNAL_TOKEN: string;
  PLATFORM_ADMIN_EMAILS: string;
}

export interface OptionalSecrets {
  ALLOWED_DOMAINS?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  SENTRY_DSN_API?: string;
  SENTRY_DSN_APP?: string;
  SENTRY_DSN_SIDECAR?: string;
}

const KEEP_LABEL = "(unchanged)";

function maskedHint(current: string | undefined): string | undefined {
  if (!current) return undefined;
  if (current.length <= 8) return KEEP_LABEL;
  return `${KEEP_LABEL} — ${current.slice(0, 4)}...${current.slice(-4)}`;
}

/**
 * Prompt for a secret. Empty input keeps the current value (if any).
 * The prompt itself never echoes characters back.
 */
async function promptSecret(opts: {
  message: string;
  current: string | undefined;
  validate?: (raw: string) => string | undefined;
  required: boolean;
}): Promise<string | null> {
  const v = await password({
    message: opts.message,
    mask: "•",
    validate: (raw) => {
      const t = raw.trim();
      if (t === "") {
        if (opts.current) return undefined; // keeping current
        if (opts.required) return "Required. Press Ctrl+C to abort.";
        return undefined; // skipping optional
      }
      return opts.validate ? opts.validate(t) : undefined;
    },
  });
  if (isCancel(v)) return null;
  const t = (v as string).trim();
  if (t === "") return opts.current ?? "";
  return t;
}

async function promptText(opts: {
  message: string;
  current: string | undefined;
  placeholder?: string;
  validate?: (raw: string) => string | undefined;
  required: boolean;
}): Promise<string | null> {
  const v = await text({
    message: opts.message,
    placeholder: opts.placeholder,
    initialValue: opts.current ?? "",
    validate: (raw) => {
      const t = raw.trim();
      if (t === "") {
        if (opts.required && !opts.current)
          return "Required. Press Ctrl+C to abort.";
        return undefined;
      }
      return opts.validate ? opts.validate(t) : undefined;
    },
  });
  if (isCancel(v)) return null;
  const t = (v as string).trim();
  return t === "" ? opts.current ?? "" : t;
}

/**
 * Generate a 32-byte hex secret. Used for JWT_SECRET and
 * API_INTERNAL_TOKEN when the user doesn't have one yet.
 */
function generateHexSecret(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export async function promptRequiredSecrets(
  current: Partial<RequiredSecrets>,
): Promise<RequiredSecrets | null> {
  // JWT_SECRET — offer to auto-generate.
  let jwt = current.JWT_SECRET ?? "";
  if (!jwt) {
    const gen = await confirm({
      message: "Generate a JWT_SECRET for you? (32 random bytes, hex-encoded)",
      initialValue: true,
    });
    if (isCancel(gen)) return null;
    if (gen) {
      jwt = generateHexSecret();
      log.success("JWT_SECRET generated.");
    } else {
      const v = await promptSecret({
        message: "JWT_SECRET (32+ hex chars)",
        current: undefined,
        required: true,
        validate: (t) =>
          t.length >= 32 ? undefined : "At least 32 chars, please.",
      });
      if (v === null) return null;
      jwt = v;
    }
  } else {
    log.info("JWT_SECRET already set — keeping.");
  }

  // API_INTERNAL_TOKEN — auto-generate if missing.
  let apiToken = current.API_INTERNAL_TOKEN ?? "";
  if (!apiToken) {
    apiToken = generateHexSecret(24);
    log.success("API_INTERNAL_TOKEN generated.");
  } else {
    log.info("API_INTERNAL_TOKEN already set — keeping.");
  }

  // ANTHROPIC credentials are captured in their own step (steps/anthropic.ts)
  // because the credential source can be Vertex AI on GCP installs — see
  // configure/index.ts orchestration.

  // PLATFORM_ADMIN_EMAILS — required, comma-separated.
  const admins = await promptText({
    message: "Platform admin email(s), comma-separated",
    current: current.PLATFORM_ADMIN_EMAILS,
    placeholder: "you@example.com,colleague@example.com",
    required: true,
    validate: (t) => {
      const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) return "At least one email required.";
      for (const p of parts) {
        if (!/.+@.+\..+/.test(p)) return `Invalid email: ${p}`;
      }
      return undefined;
    },
  });
  if (admins === null) return null;

  return {
    JWT_SECRET: jwt,
    API_INTERNAL_TOKEN: apiToken,
    PLATFORM_ADMIN_EMAILS: admins,
  };
}

export async function promptOptionalSecrets(
  current: Partial<OptionalSecrets>,
): Promise<OptionalSecrets | null> {
  const out: OptionalSecrets = { ...current };

  // === Allowed sign-in domains ===
  const allowed = await promptText({
    message:
      "Allowed Google sign-in domains (comma-separated), or blank for any verified Google account",
    current: current.ALLOWED_DOMAINS,
    placeholder: "x1agent.com,example.com",
    required: false,
  });
  if (allowed === null) return null;
  if (allowed) out.ALLOWED_DOMAINS = allowed;

  // === Google OAuth (for user sign-in) ===
  const wantOAuth = await confirm({
    message: "Configure Google OAuth (for user sign-in) now?",
    initialValue: !!current.GOOGLE_OAUTH_CLIENT_ID,
  });
  if (isCancel(wantOAuth)) return null;
  if (wantOAuth) {
    const id = await promptSecret({
      message: `Google OAuth client ID ${maskedHint(current.GOOGLE_OAUTH_CLIENT_ID) ?? ""}`,
      current: current.GOOGLE_OAUTH_CLIENT_ID,
      required: false,
    });
    if (id === null) return null;
    if (id) out.GOOGLE_OAUTH_CLIENT_ID = id;

    const sec = await promptSecret({
      message: `Google OAuth client secret ${maskedHint(current.GOOGLE_OAUTH_CLIENT_SECRET) ?? ""}`,
      current: current.GOOGLE_OAUTH_CLIENT_SECRET,
      required: false,
    });
    if (sec === null) return null;
    if (sec) out.GOOGLE_OAUTH_CLIENT_SECRET = sec;
  }

  // === GitHub App (for repo features) ===
  const wantGh = await confirm({
    message: "Configure a GitHub App (for repo + agent integrations) now?",
    initialValue: !!current.GITHUB_APP_ID,
  });
  if (isCancel(wantGh)) return null;
  if (wantGh) {
    const id = await promptText({
      message: "GitHub App ID (numeric)",
      current: current.GITHUB_APP_ID,
      placeholder: "123456",
      required: false,
      validate: (t) => (/^\d+$/.test(t) ? undefined : "Should be a number."),
    });
    if (id === null) return null;
    if (id) out.GITHUB_APP_ID = id;

    const slug = await promptText({
      message: "GitHub App slug",
      current: current.GITHUB_APP_SLUG,
      placeholder: "x1agent-yourorg",
      required: false,
    });
    if (slug === null) return null;
    if (slug) out.GITHUB_APP_SLUG = slug;

    const cid = await promptSecret({
      message: `GitHub App client ID ${maskedHint(current.GITHUB_APP_CLIENT_ID) ?? ""}`,
      current: current.GITHUB_APP_CLIENT_ID,
      required: false,
    });
    if (cid === null) return null;
    if (cid) out.GITHUB_APP_CLIENT_ID = cid;

    const csec = await promptSecret({
      message: `GitHub App client secret ${maskedHint(current.GITHUB_APP_CLIENT_SECRET) ?? ""}`,
      current: current.GITHUB_APP_CLIENT_SECRET,
      required: false,
    });
    if (csec === null) return null;
    if (csec) out.GITHUB_APP_CLIENT_SECRET = csec;

    const wsec = await promptSecret({
      message: `GitHub App webhook secret ${maskedHint(current.GITHUB_APP_WEBHOOK_SECRET) ?? ""}`,
      current: current.GITHUB_APP_WEBHOOK_SECRET,
      required: false,
    });
    if (wsec === null) return null;
    if (wsec) out.GITHUB_APP_WEBHOOK_SECRET = wsec;

    log.warn(
      "Skipping GITHUB_APP_PRIVATE_KEY here — paste it directly into .env.local\n" +
        "with newlines escaped as \\n. Multi-line key entry in a TUI is error-prone.",
    );
  }

  // === Slack ===
  const wantSlack = await confirm({
    message: "Configure a Slack bot token (for messaging provider) now?",
    initialValue: !!current.SLACK_BOT_TOKEN,
  });
  if (isCancel(wantSlack)) return null;
  if (wantSlack) {
    const tok = await promptSecret({
      message: `Slack bot token (xoxb-...) ${maskedHint(current.SLACK_BOT_TOKEN) ?? ""}`,
      current: current.SLACK_BOT_TOKEN,
      required: false,
      validate: (t) =>
        t.startsWith("xoxb-")
          ? undefined
          : "Slack bot tokens start with 'xoxb-'.",
    });
    if (tok === null) return null;
    if (tok) out.SLACK_BOT_TOKEN = tok;
  }

  // === Sentry ===
  // Three DSNs (one per runtime). All optional; SDKs no-op when unset.
  // Stored as secrets even though DSNs aren't truly secret — the auth
  // key inside DOES grant ingest, so it's prudent to bind via GSM.
  const wantSentry = await confirm({
    message: "Configure Sentry DSNs (api / app / sidecar) now?",
    initialValue: !!(
      current.SENTRY_DSN_API ||
      current.SENTRY_DSN_APP ||
      current.SENTRY_DSN_SIDECAR
    ),
  });
  if (isCancel(wantSentry)) return null;
  if (wantSentry) {
    for (const key of [
      "SENTRY_DSN_API",
      "SENTRY_DSN_APP",
      "SENTRY_DSN_SIDECAR",
    ] as const) {
      const cur = current[key];
      const dsn = await promptSecret({
        message: `${key} ${maskedHint(cur) ?? ""}`,
        current: cur,
        required: false,
        validate: (t) =>
          t.startsWith("https://") && t.includes("@")
            ? undefined
            : "Sentry DSN looks like https://<key>@<host>/<project_id>",
      });
      if (dsn === null) return null;
      if (dsn) out[key] = dsn;
    }
  }

  return out;
}
