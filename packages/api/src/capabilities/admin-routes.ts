import { Hono, type Context, type MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { GoogleAuth } from "google-auth-library";
import { Email } from "@x1agent/kernel";
import { isPlatformAdmin } from "@x1agent/domain-auth";
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
               last_probe_error, last_probed_at
        FROM anthropic_model_overrides
      `,
    ]);
    const overrideById = new Map(overrides.map((r) => [r.model_id, r]));
    const rows = catalog.map((m) => {
      const o = overrideById.get(m.id);
      return {
        id: m.id,
        label: m.label,
        source: m.source,
        enabled: o?.enabled ?? false,
        last_probe_status: o?.last_probe_status ?? null,
        last_probe_error: o?.last_probe_error ?? null,
        last_probed_at: o?.last_probed_at ?? null,
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
    const body = await c.req
      .json<{ enabled?: boolean }>()
      .catch(() => ({}) as { enabled?: boolean });
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled boolean required" }, 400);
    }
    const enabled = body.enabled;
    await cfg.sql`
      INSERT INTO anthropic_model_overrides (model_id, enabled, updated_at)
      VALUES (${id}, ${enabled}, NOW())
      ON CONFLICT (model_id) DO UPDATE SET
        enabled    = EXCLUDED.enabled,
        updated_at = NOW()
    `;
    return c.json({ ok: true });
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

