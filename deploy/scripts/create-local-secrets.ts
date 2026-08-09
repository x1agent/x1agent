import { resolve } from "node:path";
import { EnvFile } from "../../packages/cli/src/configure/env-file.ts";

const path = resolve(process.argv[2] ?? ".env.local");
const env = new EnvFile(path);
const namespace = process.env.X1AGENT_NAMESPACE ?? "x1agent";
const required = ["JWT_SECRET", "WORKSPACE_SECRETS_MASTER_KEY"];
const missing = required.filter((key) => !env.get(key));
if (missing.length > 0) {
  console.error(`Missing required values in ${path}: ${missing.join(", ")}`);
  process.exit(1);
}

const keys = [
  "JWT_SECRET", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_SCOPES", "ALLOWED_DOMAINS", "PLATFORM_ADMIN_EMAILS",
  "ADMIN_MCP_ENABLED",
  "AUTH_BYPASS", "TEST_USER", "GITHUB_APP_ID", "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "WORKSPACE_SECRETS_MASTER_KEY", "API_INTERNAL_TOKEN", "SLACK_BOT_TOKEN",
  "SENTRY_DSN_API", "PUBLIC_SENTRY_DSN_APP", "SENTRY_DSN_SIDECAR",
  "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE",
];

const data: Record<string, string> = {};
for (const key of keys) {
  const value = env.get(key);
  if (value !== undefined && value !== "") data[key] = Buffer.from(value).toString("base64");
}

console.log(JSON.stringify({
  apiVersion: "v1", kind: "Secret",
  metadata: { name: "x1agent-dev-secrets", namespace },
  type: "Opaque", data,
}));
