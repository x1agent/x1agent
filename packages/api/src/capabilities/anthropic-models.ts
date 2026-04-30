/**
 * Resolve the list of Claude models the deployment can actually run.
 *
 * Two providers, two upstream catalogs:
 *
 *   vertex   — Vertex Model Garden lists Anthropic publishers per
 *              project + region. Each model also requires explicit
 *              ToS acceptance in the GCP Console before runtime calls
 *              succeed; the catalog returns models that are merely
 *              listable. We surface them anyway and let the operator
 *              click through if a session 404s on use.
 *
 *   api_key  — api.anthropic.com/v1/models scoped to the API key.
 *              Returns whatever Anthropic's account tier offers.
 *
 * Result is cached for 5 minutes so the dropdown is snappy and
 * Vertex/Anthropic don't see a per-pageload spike. On any upstream
 * error we return an empty list rather than 500 so the UI shows
 * "Custom..." instead of getting stuck on a spinner.
 */

import { GoogleAuth } from "google-auth-library";

export interface AnthropicModel {
  /** Model id used by the SDK (e.g. claude-sonnet-4-5@20250929 on Vertex). */
  id: string;
  /** Human-friendly label for the dropdown. */
  label: string;
  /** vertex | api_key — purely informational for the UI. */
  source: "vertex" | "api_key";
}

interface CacheEntry {
  fetchedAt: number;
  models: AnthropicModel[];
}
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CacheEntry | null = null;

export async function listAnthropicModels(): Promise<AnthropicModel[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }
  const provider = process.env.ANTHROPIC_PROVIDER ?? "api_key";
  let models: AnthropicModel[] = [];
  try {
    if (provider === "vertex") {
      models = await listVertexModels();
    } else {
      models = await listAnthropicApiModels();
    }
  } catch (err) {
    console.warn(
      `[anthropic-models] upstream fetch failed: ${(err as Error).message}`,
    );
    models = [];
  }
  cache = { fetchedAt: now, models };
  return models;
}

async function listVertexModels(): Promise<AnthropicModel[]> {
  const region = process.env.CLOUD_ML_REGION || "us-east5";
  const project =
    process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (!project) {
    throw new Error("ANTHROPIC_VERTEX_PROJECT_ID / GCP_PROJECT_ID unset");
  }
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const url = `https://${region}-aiplatform.googleapis.com/v1beta1/publishers/anthropic/models`;
  const res = await client.request<{
    publisherModels?: Array<{
      name?: string;
      versionId?: string;
      publisherModelTemplate?: string;
    }>;
  }>({
    url,
    headers: { "x-goog-user-project": project },
  });

  const out: AnthropicModel[] = [];
  for (const m of res.data.publisherModels ?? []) {
    // name = "publishers/anthropic/models/claude-sonnet-4-5"
    const baseId = m.name?.split("/").pop();
    const ver = m.versionId;
    if (!baseId || !ver) continue;
    const id = `${baseId}@${ver}`;
    out.push({ id, label: prettifyVertexLabel(baseId, ver), source: "vertex" });
  }
  // Sort: GA (date-versioned) first, then "@default" preview labels
  // last. Inside each group, newest first by string sort on the
  // yyyymmdd version. The catalog lists @default aliases for some
  // pre-GA models (Sonnet 4.6, Opus 4.7 etc.) that show up in the
  // publisher list but aren't yet inference-servable — keep them
  // visible but never auto-select.
  out.sort((a, b) => {
    const aDefault = a.id.endsWith("@default");
    const bDefault = b.id.endsWith("@default");
    if (aDefault !== bDefault) return aDefault ? 1 : -1;
    return b.id.localeCompare(a.id);
  });
  return out;
}

function prettifyVertexLabel(baseId: string, version: string): string {
  // claude-sonnet-4-5 → "Claude Sonnet 4.5"
  // claude-3-5-haiku  → "Claude 3.5 Haiku"
  const cleaned = baseId
    .replace(/^claude-/, "")
    .split("-")
    .map((s) => (/^\d+$/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(" ")
    .replace(/(\d+) (\d+)/g, "$1.$2");
  const yyyymmdd = version.match(/^(\d{4})(\d{2})(\d{2})$/);
  const dateLabel = yyyymmdd
    ? `${yyyymmdd[1]}-${yyyymmdd[2]}-${yyyymmdd[3]}`
    : `${version} — preview, may 400`;
  return `Claude ${cleaned} (${dateLabel})`;
}

async function listAnthropicApiModels(): Promise<AnthropicModel[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(`anthropic /v1/models returned ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; display_name?: string }>;
  };
  return (json.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => !!m.id)
    .map((m) => ({
      id: m.id,
      label: m.display_name ?? m.id,
      source: "api_key" as const,
    }));
}
