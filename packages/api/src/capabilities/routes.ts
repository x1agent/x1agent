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
   * returns only models an admin has explicitly enabled once the allowlist
   * is active. With no enabled rows, the deployment has not been curated
   * yet and the full authoritative catalog remains available.
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
    const enabled = cfg.sql ? await listEnabledOverrides(cfg.sql) : null;
    // The allowlist becomes active only after an admin enables at least one
    // row. Probe-only and price-only rows are deliberately not policy.
    const models = applyEnabledModelPolicy(catalog, enabled);
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
    if (!cfg.sql)
      return c.json({ runtime_type: runtime, default: null, models: [] });
    const rows = await cfg.sql<
      {
        model_id: string;
        display_name: string;
        input_usd_per_million: string | number | null;
        output_usd_per_million: string | number | null;
        source: string | null;
        is_default: boolean;
      }[]
    >`
      SELECT model_id, display_name, input_usd_per_million,
             output_usd_per_million, source, is_default
      FROM runtime_models
      WHERE runtime_type = ${runtime} AND enabled = TRUE
        AND (
          ${runtime} <> 'claude_code' OR
          NOT EXISTS (
            SELECT 1 FROM anthropic_model_overrides WHERE enabled = TRUE
          ) OR
          EXISTS (
              SELECT 1 FROM anthropic_model_overrides policy
              WHERE policy.enabled = TRUE
                AND (
                  policy.model_id = runtime_models.model_id OR
                  policy.model_id = runtime_models.resolved_model_id
                )
            )
        )
      ORDER BY is_default DESC, display_name ASC
    `;
    return c.json({
      runtime_type: runtime,
      default: rows.find((model) => model.is_default)?.model_id ?? null,
      models: rows.map((m) => ({
        runtime_type: runtime,
        id: m.model_id,
        label: m.display_name,
        input_usd_per_million:
          m.input_usd_per_million === null
            ? null
            : Number(m.input_usd_per_million),
        output_usd_per_million:
          m.output_usd_per_million === null
            ? null
            : Number(m.output_usd_per_million),
        source: m.source,
      })),
    });
  });
  return app;
}

export function applyEnabledModelPolicy<T extends { id: string }>(
  catalog: readonly T[],
  enabled: ReadonlySet<string> | null,
): T[] {
  return enabled && enabled.size > 0
    ? catalog.filter((model) => enabled.has(model.id))
    : [...catalog];
}

export async function listEnabledRuntimeModels(
  sql: postgres.Sql<Record<string, unknown>>,
  runtime: "claude_code" | "codex",
): Promise<Set<string>> {
  const rows = await sql<{ model_id: string }[]>`
    SELECT catalog.model_id FROM runtime_models catalog
    WHERE catalog.runtime_type = ${runtime} AND catalog.enabled = TRUE
      AND (
        ${runtime} <> 'claude_code' OR
        NOT EXISTS (
          SELECT 1 FROM anthropic_model_overrides WHERE enabled = TRUE
        ) OR
        EXISTS (
            SELECT 1 FROM anthropic_model_overrides policy
            WHERE policy.enabled = TRUE
              AND (
                policy.model_id = catalog.model_id OR
                policy.model_id = catalog.resolved_model_id
              )
          )
      )
  `;
  return new Set(rows.map((row) => row.model_id));
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
