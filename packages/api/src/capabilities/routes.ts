import { Hono } from "hono";
import { readCapabilitiesFromEnv } from "./capabilities.js";
import { listAnthropicModels } from "./anthropic-models.js";

/**
 * GET /api/capabilities — snapshot of which provider domains are
 * installed in this deployment. Public-ish: no PII, just feature
 * flags. Frontend reads this once at boot to gate UI surfaces.
 *
 * Cache headers are short — operators can flip a provider on by
 * helm-upgrading and want the UI to reflect it within a minute.
 */
export function capabilitiesRoutes() {
  const app = new Hono();
  app.get("/", (c) => {
    c.header("Cache-Control", "public, max-age=30");
    return c.json(readCapabilitiesFromEnv());
  });
  // /api/capabilities/anthropic/models — single source of truth for
  // which Claude model ids the deployment can run. Backend dispatches
  // by ANTHROPIC_PROVIDER; the frontend never hardcodes a list.
  app.get("/anthropic/models", async (c) => {
    const models = await listAnthropicModels();
    c.header("Cache-Control", "private, max-age=60");
    return c.json({
      provider: process.env.ANTHROPIC_PROVIDER ?? "api_key",
      // The deployment-wide default — what an agent inherits when no
      // per-agent override is set. Falls back to the first Sonnet
      // model in the catalog when ANTHROPIC_MODEL env is unset.
      default: pickDefaultModel(models),
      models,
    });
  });
  return app;
}

function pickDefaultModel(
  models: { id: string; label: string }[],
): string | null {
  const explicit = process.env.ANTHROPIC_MODEL;
  if (explicit && explicit.trim()) return explicit.trim();
  // Prefer Sonnet — the common-case workhorse. Newest first by
  // virtue of listAnthropicModels() returning sorted desc.
  const sonnet = models.find((m) => m.id.toLowerCase().includes("sonnet"));
  if (sonnet) return sonnet.id;
  return models[0]?.id ?? null;
}
