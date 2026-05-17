import { Hono, type Context, type MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { GoogleAuth } from "google-auth-library";
import { Email } from "@x1agent/kernel";
import { isPlatformAdmin } from "@x1agent/domain-auth";
import { tierDefaultPrices } from "@x1agent/domain-sessions";
import { listAnthropicModels } from "./anthropic-models.js";

/**
 * Admin curation surface for the Claude model dropdown.
 *
 *   GET    /         — catalog × override state, with last probe result
 *   POST   /:id/test — 1-token rawPredict probe; persists result
 *   PATCH  /:id      — { enabled: boolean }; upserts the override row
 *
 * All routes require platform admin. The catalog itself comes from the
 * upstream provider (Vertex Model Garden or Anthropic /v1/models) so
 * this surface only stores admin opinions on top of it.
 */

export interface AdminAnthropicModelsConfig {
  sql: postgres.Sql<Record<string, unknown>>;
  platformAdmins: readonly string[];
  requireAuth: MiddlewareHandler;
}

interface OverrideRow {
  model_id: string;
  enabled: boolean;
  last_probe_status: string | null;
  last_probe_error: string | null;
  last_probed_at: Date | null;
  input_usd_per_million: string | null;
  output_usd_per_million: string | null;
  cache_read_multiplier: string | null;
  cache_write_multiplier: string | null;
}

export function createAdminAnthropicModelsRoutes(
  cfg: AdminAnthropicModelsConfig,
): Hono {
  const app = new Hono();

  app.use("*", cfg.requireAuth);
  app.use("*", async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    if (!isPlatformAdmin(Email(session.email), cfg.platformAdmins)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  app.get("/", async (c) => {
    const [catalog, overrides] = await Promise.all([
      listAnthropicModels(),
      cfg.sql<OverrideRow[]>`
        SELECT model_id, enabled, last_probe_status,
               last_probe_error, last_probed_at,
               input_usd_per_million, output_usd_per_million,
               cache_read_multiplier, cache_write_multiplier
        FROM anthropic_model_overrides
      `,
    ]);
    const overrideById = new Map(overrides.map((r) => [r.model_id, r]));
    const rows = catalog.map((m) => {
      const o = overrideById.get(m.id);
      const def = tierDefaultPrices(m.id);
      const numOrNull = (s: string | null | undefined): number | null =>
        s === null || s === undefined ? null : Number(s);
      return {
        id: m.id,
        label: m.label,
        source: m.source,
        enabled: o?.enabled ?? false,
        last_probe_status: o?.last_probe_status ?? null,
        last_probe_error: o?.last_probe_error ?? null,
        last_probed_at: o?.last_probed_at ?? null,
        // Each `*_saved` is the operator's explicit override (null
        // means "not pinned, use the default"). Each `*_default` is
        // the tier-classifier guess; the UI seeds inputs with these
        // when no override is saved so the form is never empty.
        input_usd_per_million_saved: numOrNull(o?.input_usd_per_million),
        output_usd_per_million_saved: numOrNull(o?.output_usd_per_million),
        cache_read_multiplier_saved: numOrNull(o?.cache_read_multiplier),
        cache_write_multiplier_saved: numOrNull(o?.cache_write_multiplier),
        input_usd_per_million_default: def.inputPerMillion,
        output_usd_per_million_default: def.outputPerMillion,
        cache_read_multiplier_default: def.cacheReadMultiplier,
        cache_write_multiplier_default: def.cacheWriteMultiplier,
      };
    });
    const anyEnabled = rows.some((r) => r.enabled);
    return c.json({
      provider: process.env.ANTHROPIC_PROVIDER ?? "api_key",
      region: process.env.CLOUD_ML_REGION ?? null,
      filtering_active: anyEnabled,
      models: rows,
    });
  });

  app.post("/:id/test", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const result = await probeModel(id);
    await cfg.sql`
      INSERT INTO anthropic_model_overrides
        (model_id, enabled, last_probe_status, last_probe_error, last_probed_at, updated_at)
      VALUES
        (${id}, FALSE, ${result.status}, ${result.error}, NOW(), NOW())
      ON CONFLICT (model_id) DO UPDATE SET
        last_probe_status = EXCLUDED.last_probe_status,
        last_probe_error  = EXCLUDED.last_probe_error,
        last_probed_at    = EXCLUDED.last_probed_at,
        updated_at        = NOW()
    `;
    return c.json(result);
  });

  app.patch("/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    interface PatchBody {
      enabled?: boolean;
      input_usd_per_million?: number | null;
      output_usd_per_million?: number | null;
      cache_read_multiplier?: number | null;
      cache_write_multiplier?: number | null;
    }
    const body: PatchBody = await c.req
      .json<PatchBody>()
      .catch(() => ({}) as PatchBody);

    // Validate each price field independently — operators can update
    // just one (e.g. clear an override) without re-sending the rest.
    // Distinguish "not provided" (omitted from body) from "set to null"
    // (explicit clear) so partial PATCH semantics work cleanly.
    const validateOptionalNumber = (
      v: unknown,
      field: string,
      min: number,
    ): { ok: true; value: number | null | undefined } | { ok: false; err: string } => {
      if (v === undefined) return { ok: true, value: undefined };
      if (v === null) return { ok: true, value: null };
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { ok: false, err: `${field} must be a finite number or null` };
      }
      if (v < min) {
        return { ok: false, err: `${field} must be ≥ ${min}` };
      }
      return { ok: true, value: v };
    };

    const inputRate = validateOptionalNumber(
      body.input_usd_per_million,
      "input_usd_per_million",
      0,
    );
    const outputRate = validateOptionalNumber(
      body.output_usd_per_million,
      "output_usd_per_million",
      0,
    );
    const cacheRead = validateOptionalNumber(
      body.cache_read_multiplier,
      "cache_read_multiplier",
      0,
    );
    const cacheWrite = validateOptionalNumber(
      body.cache_write_multiplier,
      "cache_write_multiplier",
      0,
    );
    if (!inputRate.ok) return c.json({ error: inputRate.err }, 400);
    if (!outputRate.ok) return c.json({ error: outputRate.err }, 400);
    if (!cacheRead.ok) return c.json({ error: cacheRead.err }, 400);
    if (!cacheWrite.ok) return c.json({ error: cacheWrite.err }, 400);

    const enabledProvided = typeof body.enabled === "boolean";
    const anyPriceProvided =
      inputRate.value !== undefined ||
      outputRate.value !== undefined ||
      cacheRead.value !== undefined ||
      cacheWrite.value !== undefined;

    if (!enabledProvided && !anyPriceProvided) {
      return c.json(
        { error: "at least one of enabled / price fields required" },
        400,
      );
    }

    // Build the upsert. For each field the caller didn't include in
    // the body (value === undefined), keep whatever's already in the
    // row on conflict; for fields they did include (including
    // explicit null = "clear the override"), apply the new value.
    // INSERT path uses null where the caller didn't include — first-
    // ever rows for this model won't have anything to preserve.
    const inputForInsert = inputRate.value === undefined ? null : inputRate.value;
    const outputForInsert =
      outputRate.value === undefined ? null : outputRate.value;
    const cacheReadForInsert =
      cacheRead.value === undefined ? null : cacheRead.value;
    const cacheWriteForInsert =
      cacheWrite.value === undefined ? null : cacheWrite.value;
    const enabledForInsert = enabledProvided ? body.enabled! : false;

    await cfg.sql`
      INSERT INTO anthropic_model_overrides
        (model_id, enabled,
         input_usd_per_million, output_usd_per_million,
         cache_read_multiplier, cache_write_multiplier,
         updated_at)
      VALUES
        (${id}, ${enabledForInsert},
         ${inputForInsert}, ${outputForInsert},
         ${cacheReadForInsert}, ${cacheWriteForInsert},
         NOW())
      ON CONFLICT (model_id) DO UPDATE SET
        enabled                = ${
          enabledProvided
            ? cfg.sql`EXCLUDED.enabled`
            : cfg.sql`anthropic_model_overrides.enabled`
        },
        input_usd_per_million  = ${
          inputRate.value === undefined
            ? cfg.sql`anthropic_model_overrides.input_usd_per_million`
            : cfg.sql`EXCLUDED.input_usd_per_million`
        },
        output_usd_per_million = ${
          outputRate.value === undefined
            ? cfg.sql`anthropic_model_overrides.output_usd_per_million`
            : cfg.sql`EXCLUDED.output_usd_per_million`
        },
        cache_read_multiplier  = ${
          cacheRead.value === undefined
            ? cfg.sql`anthropic_model_overrides.cache_read_multiplier`
            : cfg.sql`EXCLUDED.cache_read_multiplier`
        },
        cache_write_multiplier = ${
          cacheWrite.value === undefined
            ? cfg.sql`anthropic_model_overrides.cache_write_multiplier`
            : cfg.sql`EXCLUDED.cache_write_multiplier`
        },
        updated_at             = NOW()
    `;
    return c.json({ ok: true });
  });

  // Summarizer model selection. The Vertex / API-key session
  // summarizer (packages/domains/sessions/src/adapters/anthropic/...)
  // calls readSummaryModel() before each request so a change here
  // takes effect without an api restart.
  //
  // GET returns the current selection plus the last-update audit fields.
  // PUT replaces it. PUT with model_id=null clears the selection — the
  // summarizer falls back to its compiled-in default.
  app.get("/summary-model", async (c) => {
    const rows = await cfg.sql<
      { value: string; updated_at: Date; updated_by: string | null }[]
    >`
      SELECT value, updated_at, updated_by
      FROM platform_settings
      WHERE key = 'anthropic.summary_model'
    `;
    const row = rows[0];
    return c.json({
      model_id: row ? (row.value as unknown as string) : null,
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    });
  });

  app.put("/summary-model", async (c) => {
    const session = c.get("session");
    const body = await c.req
      .json<{ model_id?: string | null }>()
      .catch(() => ({}) as { model_id?: string | null });

    if (body.model_id === undefined) {
      return c.json({ error: "model_id required (string or null)" }, 400);
    }
    if (body.model_id !== null && typeof body.model_id !== "string") {
      return c.json({ error: "model_id must be string or null" }, 400);
    }
    if (typeof body.model_id === "string" && body.model_id.trim() === "") {
      return c.json({ error: "model_id cannot be empty string" }, 400);
    }

    if (body.model_id === null) {
      await cfg.sql`DELETE FROM platform_settings WHERE key = 'anthropic.summary_model'`;
      return c.json({ ok: true, model_id: null });
    }

    const modelId = body.model_id;
    const updatedBy = session?.email ?? null;
    await cfg.sql`
      INSERT INTO platform_settings (key, value, updated_at, updated_by)
      VALUES ('anthropic.summary_model', ${cfg.sql.json(modelId)}, NOW(), ${updatedBy})
      ON CONFLICT (key) DO UPDATE SET
        value      = EXCLUDED.value,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
    `;
    return c.json({ ok: true, model_id: modelId });
  });

  return app;
}

interface ProbeResult {
  status: "ok" | "not_servable" | "quota_exhausted" | "forbidden" | "error";
  http_status: number | null;
  error: string | null;
}

async function probeModel(modelId: string): Promise<ProbeResult> {
  const provider = process.env.ANTHROPIC_PROVIDER ?? "api_key";
  if (provider === "vertex") return probeVertex(modelId);
  return probeAnthropicApi(modelId);
}

async function probeVertex(modelId: string): Promise<ProbeResult> {
  const region = process.env.CLOUD_ML_REGION || "global";
  const project =
    process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (!project) {
    return {
      status: "error",
      http_status: null,
      error: "ANTHROPIC_VERTEX_PROJECT_ID / GCP_PROJECT_ID unset",
    };
  }
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  // Vertex AI was rebranded to Gemini Enterprise Agent Platform at
  // Cloud Next 2026. The API surface (`aiplatform.googleapis.com`) is
  // unchanged — backward compat preserved per Google's transition doc.
  // The "global" location uses the unprefixed hostname; everywhere
  // else gets a `<region>-aiplatform.*` prefix.
  const host =
    region === "global"
      ? "aiplatform.googleapis.com"
      : `${region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${modelId}:rawPredict`;
  try {
    await client.request({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-user-project": project,
      },
      data: {
        anthropic_version: "vertex-2023-10-16",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      },
    });
    return { status: "ok", http_status: 200, error: null };
  } catch (err: unknown) {
    const e = err as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    const httpStatus = e.response?.status ?? null;
    const body = e.response?.data;
    const bodyMsg = extractErrorMessage(body) ?? e.message ?? "unknown error";
    let status: ProbeResult["status"] = "error";
    if (httpStatus === 404) status = "not_servable";
    else if (httpStatus === 403) status = "forbidden";
    else if (httpStatus === 429) status = "quota_exhausted";
    else if (httpStatus === 400) {
      // 400 usually means "not servable in region" — same actionable
      // signal as 404 from the operator's perspective.
      status = /not servable|not available|publisher model/i.test(bodyMsg)
        ? "not_servable"
        : "error";
    }
    return { status, http_status: httpStatus, error: bodyMsg };
  }
}

async function probeAnthropicApi(modelId: string): Promise<ProbeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: "error",
      http_status: null,
      error: "ANTHROPIC_API_KEY unset",
    };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (res.ok) return { status: "ok", http_status: 200, error: null };
  const body = await res.text();
  let status: ProbeResult["status"] = "error";
  if (res.status === 404) status = "not_servable";
  else if (res.status === 403) status = "forbidden";
  else if (res.status === 429) status = "quota_exhausted";
  return { status, http_status: res.status, error: body.slice(0, 500) };
}

function extractErrorMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    const b = body as { error?: { message?: string }; message?: string };
    return b.error?.message ?? b.message ?? JSON.stringify(body).slice(0, 500);
  }
  return null;
}

// Re-exported for the capabilities filter.
export async function listEnabledOverrides(
  sql: postgres.Sql<Record<string, unknown>>,
): Promise<Set<string>> {
  const rows = await sql<{ model_id: string }[]>`
    SELECT model_id FROM anthropic_model_overrides WHERE enabled = TRUE
  `;
  return new Set(rows.map((r) => r.model_id));
}

