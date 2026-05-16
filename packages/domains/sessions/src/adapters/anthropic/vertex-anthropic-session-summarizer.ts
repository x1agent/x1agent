import type { SessionEvent } from "../../domain/event.js";
import { renderTranscript } from "../../domain/render-transcript.js";
import type { SessionSummarizer } from "../../ports/session-summarizer.js";

/**
 * SessionSummarizer adapter that routes through Google Vertex AI's
 * Anthropic-publisher endpoint instead of api.anthropic.com.
 *
 * Why a sibling of `AnthropicSessionSummarizer` instead of branching
 * inside it: the auth model is completely different (Workload Identity
 * token from the GCE metadata server vs static api key), the URL is
 * different (per-region Google endpoint vs the global one), the
 * request envelope wraps in a Vertex-specific `anthropic_version`
 * field, and the error shapes diverge enough that one adapter trying
 * to handle both would have more branching than substance. Two thin
 * adapters with shared `extractText` + `renderTranscript` is cleaner.
 *
 * Auth: per-call token via the metadata server. The pod's service
 * account must have `aiplatform.user` (or equivalent) on the project.
 * Workload Identity is bound by Terraform during `mise run install`.
 *
 * Failure handling: every error path swallows and returns null. A
 * missing token, a 5xx from Vertex, a malformed response — all just
 * yield "no summary this round." The session row's summary stays
 * NULL and the UI falls back to the id hash, same as the stub path.
 */
export interface VertexAnthropicSessionSummarizerOptions {
  /** GCP project id hosting the Vertex AI publisher endpoint. */
  projectId: string;
  /** Vertex region, e.g. "us-east5". Must be one with Anthropic models live. */
  region: string;
  /**
   * Anthropic publisher model id in Vertex's `<base>@<version>` form
   * (e.g. "claude-haiku-4-5@default"). Default tracks Haiku because
   * summary generation is high-volume / low-stakes. Override per
   * install via env if a region serves a different id.
   */
  model?: string;
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Override the metadata-server URL for tests. Defaults to the
   * standard GCE metadata IP. The token endpoint itself is appended.
   */
  metadataBaseUrl?: string;
  /** Override the Vertex base URL pattern. Defaults to the per-region production endpoint. */
  vertexBaseUrl?: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5@default";
const DEFAULT_METADATA_BASE_URL = "http://metadata.google.internal";
const MAX_SUMMARY_CHARS = 120;

const SYSTEM_PROMPT = [
  "You produce one-line descriptions of in-progress agent sessions.",
  "Output ONLY the description. No prefixes, no quotes, no markdown,",
  "no trailing punctuation. Maximum 100 characters. Active voice,",
  "present tense. Focus on the user's apparent goal, not the agent's",
  "internal mechanics.",
].join(" ");

export class VertexAnthropicSessionSummarizer implements SessionSummarizer {
  private readonly projectId: string;
  private readonly region: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly metadataBaseUrl: string;
  private readonly vertexBaseUrl: string;

  constructor(opts: VertexAnthropicSessionSummarizerOptions) {
    this.projectId = opts.projectId;
    this.region = opts.region;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.metadataBaseUrl = opts.metadataBaseUrl ?? DEFAULT_METADATA_BASE_URL;
    // Vertex AI's global endpoint is unprefixed (aiplatform.googleapis.com
    // with `locations/global/...` in the path). Every other region uses the
    // per-region host shape. The Claude Code SDK handles this transparently;
    // we have to do it by hand because we build the URL ourselves.
    this.vertexBaseUrl =
      opts.vertexBaseUrl ??
      (opts.region === "global"
        ? "https://aiplatform.googleapis.com"
        : `https://${opts.region}-aiplatform.googleapis.com`);
  }

  async summarize(events: readonly SessionEvent[]): Promise<string | null> {
    if (!this.projectId || !this.region) return null;
    const transcript = renderTranscript(events);
    if (!transcript.trim()) return null;

    const token = await this.fetchAccessToken();
    if (!token) return null;

    const url =
      `${this.vertexBaseUrl}/v1/projects/${this.projectId}` +
      `/locations/${this.region}/publishers/anthropic/models/${encodeURIComponent(this.model)}:rawPredict`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Vertex-specific envelope key — Anthropic's standard
          // anthropic-version header is replaced by this field in the
          // publisher's request body.
          anthropic_version: "vertex-2023-10-16",
          max_tokens: 80,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content:
                "Summarize this session in one short line:\n\n" + transcript,
            },
          ],
        }),
      });
    } catch (err) {
      console.warn(
        `[summarizer] vertex fetch failed: ${(err as Error).message}`,
      );
      return null;
    }
    if (!res.ok) {
      const body = await safeReadBody(res);
      console.warn(
        `[summarizer] vertex publisher returned ${res.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      console.warn(
        `[summarizer] vertex JSON parse failed: ${(err as Error).message}`,
      );
      return null;
    }
    const text = extractText(json);
    if (!text) return null;
    return text.slice(0, MAX_SUMMARY_CHARS);
  }

  /**
   * Mint a short-lived OAuth token from the GCE metadata server. Only
   * works inside a GKE pod whose service account has the Vertex AI
   * permission. Outside the cluster (local dev) this returns null and
   * the composition root should fall through to the api-key path.
   */
  private async fetchAccessToken(): Promise<string | null> {
    try {
      const tokenRes = await this.fetchImpl(
        `${this.metadataBaseUrl}/computeMetadata/v1/instance/service-accounts/default/token`,
        { headers: { "Metadata-Flavor": "Google" } },
      );
      if (!tokenRes.ok) return null;
      const body = (await tokenRes.json()) as { access_token?: string };
      return body.access_token ?? null;
    } catch {
      return null;
    }
  }
}

function extractText(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  // Vertex's Anthropic publisher returns the same response shape the
  // direct API does: `content: [{type:'text', text:'...'}]`.
  const j = json as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(j.content)) return null;
  const text = j.content
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("")
    .trim();
  return text || null;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
