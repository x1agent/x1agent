import { Hono } from "hono";
import type postgres from "postgres";
import { readCapabilitiesFromEnv } from "./capabilities.js";
import { listAnthropicModels } from "./anthropic-models.js";
import { listEnabledOverrides } from "./admin-routes.js";

/**
 * GET /api/capabilities — snapshot of which provider domains are
 * installed in this deployment. Public-ish: no PII, just feature
 * flags. Frontend reads this once at boot to gate UI surfaces.
 *
 * Cache headers are short — operators can flip a provider on by
 * helm-upgrading and want the UI to reflect it within a minute.
 */
export interface CapabilitiesRoutesConfig {
  /**
   * Optional: when set, GET /anthropic/models filters the catalog by
   * the admin-curated allowlist in `anthropic_model_overrides`. When
   * the table is empty (fresh install) the full catalog is returned
   * unchanged.
   */
  sql?: postgres.Sql<Record<string, unknown>>;
}

export function capabilitiesRoutes(cfg: CapabilitiesRoutesConfig = {}): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    c.header("Cache-Control", "public, max-age=30");
    return c.json(readCapabilitiesFromEnv());
  });
  // /api/capabilities/anthropic/models — single source of truth for
  // which Claude model ids the deployment can run. Backend dispatches
  // by ANTHROPIC_PROVIDER; the frontend never hardcodes a list.
  app.get("/anthropic/models", async (c) => {
    const catalog = await listAnthropicModels();
    let models = catalog;
    if (cfg.sql) {
      const enabled = await listEnabledOverrides(cfg.sql);
      // Filter only when the admin has actually curated something.
      // Empty table = fresh install, show full catalog.
      if (enabled.size > 0) {
        models = catalog.filter((m) => enabled.has(m.id));
      }
    }
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
  // Skip @default preview aliases — Vertex lists them but they 400
  // "not servable in region" until promoted to GA.
  const ga = models.filter((m) => !m.id.endsWith("@default"));
  // Prefer Sonnet — the common-case workhorse.
  const sonnet = ga.find((m) => m.id.toLowerCase().includes("sonnet"));
  if (sonnet) return sonnet.id;
  return ga[0]?.id ?? models[0]?.id ?? null;
}
