import { Hono } from "hono";
import type postgres from "postgres";
import { readCapabilitiesFromEnv } from "./capabilities.js";
import { listAnthropicModels } from "./anthropic-models.js";
import { listEnabledOverrides } from "./admin-routes.js";
import { RuntimeType } from "@x1agent/domain-agents";

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
   * Required for /anthropic/models filtering. When set, the endpoint
   * returns only models an admin has explicitly enabled in
   * `anthropic_model_overrides`. Empty list means the admin has not
   * curated yet — the UI surfaces a "ask your admin to enable a model"
   * empty state. We do NOT fall back to the upstream catalog: Vertex
   * Model Garden lists models that aren't actually servable in the
   * deployment's region/project, and showing them in the agent
   * dropdown produces 4xx errors at session spawn.
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
    const enabled = cfg.sql
      ? await listEnabledOverrides(cfg.sql)
      : null;
    // Strict filter: dropdown shows only what an admin enabled. When
    // the override table is unavailable (no sql configured — tests),
    // pass the catalog through.
    const models = enabled
      ? catalog.filter((m) => enabled.has(m.id))
      : catalog;
    c.header("Cache-Control", "private, max-age=60");
    return c.json({
      provider: process.env.ANTHROPIC_PROVIDER ?? "api_key",
      // The deployment-wide default — what an agent inherits when no
      // per-agent override is set. Falls back to the first Sonnet
      // model in the curated list when ANTHROPIC_MODEL env is unset.
      default: pickDefaultModel(models),
      models,
    });
  });
  app.get("/models", async (c) => {
    const runtime = RuntimeType(c.req.query("runtime_type") ?? "claude_code");
    if (runtime === "claude_code") {
      const catalog = await listAnthropicModels();
      const enabled = cfg.sql ? await listEnabledOverrides(cfg.sql) : null;
      const models = enabled ? catalog.filter((m) => enabled.has(m.id)) : catalog;
      return c.json({
        runtime_type: runtime,
        default: pickDefaultModel(models),
        models: models.map((m) => ({
          runtime_type: runtime,
          id: m.id,
          label: m.label,
          input_usd_per_million: null,
          output_usd_per_million: null,
          source: m.source,
        })),
      });
    }
    if (!cfg.sql) return c.json({ runtime_type: runtime, default: null, models: [] });
    const rows = await cfg.sql<{
      model_id: string;
      display_name: string;
      input_usd_per_million: string | number | null;
      output_usd_per_million: string | number | null;
      source: string | null;
    }[]>`
      SELECT model_id, display_name, input_usd_per_million,
             output_usd_per_million, source
      FROM runtime_models
      WHERE runtime_type = ${runtime} AND enabled = TRUE
      ORDER BY display_name ASC
    `;
    return c.json({
      runtime_type: runtime,
      default: rows[0]?.model_id ?? null,
      models: rows.map((m) => ({
        runtime_type: runtime,
        id: m.model_id,
        label: m.display_name,
        input_usd_per_million: m.input_usd_per_million === null ? null : Number(m.input_usd_per_million),
        output_usd_per_million: m.output_usd_per_million === null ? null : Number(m.output_usd_per_million),
        source: m.source,
      })),
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
