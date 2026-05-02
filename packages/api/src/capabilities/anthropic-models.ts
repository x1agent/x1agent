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

/**
 * Vertex's regional endpoints use a `<region>-aiplatform.googleapis.com`
 * hostname with `locations/<region>` in the path. The GLOBAL endpoint
 * does NOT follow that pattern: there is no `global-aiplatform.*` host
 * (the DNS record doesn't exist). Instead, global uses the unprefixed
 * `aiplatform.googleapis.com` host with `locations/global` in the path.
 *
 * We pick global as the recommended default for x1agent installs:
 *   - The listing endpoint returns the full Anthropic catalog (7+ 4.x
 *     models) instead of the sparse 2-model regional view.
 *   - Vertex routes traffic to whichever region has capacity, so a
 *     single saturated region doesn't block all inference.
 *   - ToS acceptance done at the global tier covers all regions.
 *
 * Operators who need data residency or predictable per-region latency
 * can still set CLOUD_ML_REGION to us-east5 / europe-west1 / us / eu /
 * etc.; the URL builder handles both shapes.
 */
export function vertexHost(region: string): string {
  return region === "global"
    ? "aiplatform.googleapis.com"
    : `${region}-aiplatform.googleapis.com`;
}

async function listVertexModels(): Promise<AnthropicModel[]> {
  const region = process.env.CLOUD_ML_REGION || "global";
  const project =
    process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (!project) {
    throw new Error("ANTHROPIC_VERTEX_PROJECT_ID / GCP_PROJECT_ID unset");
  }
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const url = `https://${vertexHost(region)}/v1beta1/publishers/anthropic/models`;
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

  const candidates: AnthropicModel[] = [];
  for (const m of res.data.publisherModels ?? []) {
    // name = "publishers/anthropic/models/claude-sonnet-4-5"
    const baseId = m.name?.split("/").pop();
    const ver = m.versionId;
    if (!baseId || !ver) continue;
    const id = `${baseId}@${ver}`;
    candidates.push({
      id,
      label: prettifyVertexLabel(baseId, ver),
      source: "vertex",
    });
  }

  // Return the full catalog — operators use the per-model Test
  // endpoint (POST /api/capabilities/anthropic/models/test) to verify
  // enablement on demand. Earlier auto-probe-and-filter was rejected
  // because (a) it's a slow first-hit, (b) when probes all 404 the UI
  // surfaces "no models" with no actionable signal, (c) the right UX
  // is admin-managed enablement state, not real-time probing.
  const out = candidates;
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

/**
 * 1-token rawPredict probe. Returns true iff the project has accepted
 * the Anthropic ToS for this specific model id (i.e. inference would
 * actually work). Distinguishes 404 "not enabled" from 5xx "transient"
 * — transient errors are treated as enabled to avoid hiding models
 * during a Vertex blip.
 */
async function probeVertexEnabled(
  client: { request: (opts: unknown) => Promise<unknown> },
  region: string,
  project: string,
  modelId: string,
): Promise<boolean> {
  const url = `https://${vertexHost(region)}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${modelId}:rawPredict`;
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
    return true;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) return false;
    if (status === 403) return false;
    // 4xx other than 404/403 → likely shape issue (e.g. bad model id);
    // treat as not-enabled to be safe.
    if (status && status >= 400 && status < 500) return false;
    // 5xx / network → optimistically assume enabled, log for ops.
    console.warn(
      `[anthropic-models] probe of ${modelId} returned ${status ?? "?"} — treating as enabled`,
    );
    return true;
  }
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
