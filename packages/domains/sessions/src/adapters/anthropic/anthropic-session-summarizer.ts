import type { SessionEvent } from "../../domain/event.js";
import { renderTranscript } from "../../domain/render-transcript.js";
import type { SessionSummarizer } from "../../ports/session-summarizer.js";

/**
 * SessionSummarizer adapter that calls api.anthropic.com directly.
 *
 * Why a thin fetch + the standard `/v1/messages` endpoint, not the
 * `@anthropic-ai/sdk` package? Three reasons:
 *
 *   1. The api process already has examples of this same pattern (see
 *      packages/api/src/capabilities/admin-routes.ts probeAnthropicApi).
 *      Adding a second SDK dependency just for a 1-line summary buys
 *      nothing.
 *   2. The summarizer is best-effort — it has to swallow every error
 *      shape (network, 4xx, 5xx, malformed JSON) and return null.
 *      Hand-rolled error handling is clearer than wrapping an SDK that
 *      throws typed exceptions.
 *   3. The Vertex variant lives behind the same shape (see
 *      api/src/capabilities/anthropic-models.ts). When/if a Vertex-only
 *      install needs summaries, add a sibling adapter — don't try to
 *      branch inside the request path.
 *
 * Vertex routing is deliberately NOT supported here yet. If
 * ANTHROPIC_PROVIDER=vertex and no api key is present, this adapter is
 * not constructed (composition falls back to the StubSessionSummarizer
 * and summary stays null). Filed as a follow-up in the PR body.
 */
export interface AnthropicSessionSummarizerOptions {
  /** Direct Anthropic API key (sk-ant-…). When absent, summarize() no-ops. */
  apiKey: string;
  /**
   * Model id to call. Defaults to `claude-haiku-4-5` because summary
   * generation is a high-volume, low-stakes call — Haiku is the right
   * cost / latency point. Override via env if a deployment wants a
   * different tier (e.g. for token-pricing predictability).
   */
  model?: string;
  /**
   * Override fetch for tests. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Override the upstream base URL. Defaults to api.anthropic.com. */
  baseUrl?: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const MAX_SUMMARY_CHARS = 120;

const SYSTEM_PROMPT = [
  "You produce one-line descriptions of in-progress agent sessions.",
  "Output ONLY the description. No prefixes, no quotes, no markdown,",
  "no trailing punctuation. Maximum 100 characters. Active voice,",
  "present tense. Focus on the user's apparent goal, not the agent's",
  "internal mechanics.",
].join(" ");

/**
 * Anthropic-API-backed summarizer. Construct one in composition when
 * ANTHROPIC_API_KEY is set; otherwise wire StubSessionSummarizer.
 */
export class AnthropicSessionSummarizer implements SessionSummarizer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: AnthropicSessionSummarizerOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  async summarize(events: readonly SessionEvent[]): Promise<string | null> {
    if (!this.apiKey) return null;
    const transcript = renderTranscript(events);
    if (!transcript.trim()) return null;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
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
      // Network failure — best-effort, fall through.
      console.warn(
        `[summarizer] anthropic fetch failed: ${(err as Error).message}`,
      );
      return null;
    }
    if (!res.ok) {
      const body = await safeReadBody(res);
      console.warn(
        `[summarizer] anthropic /v1/messages returned ${res.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      console.warn(
        `[summarizer] anthropic JSON parse failed: ${(err as Error).message}`,
      );
      return null;
    }
    const text = extractText(json);
    if (!text) return null;
    return text.slice(0, MAX_SUMMARY_CHARS);
  }
}

function extractText(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(j.content)) return null;
  // Concatenate every text block (Claude sometimes splits short
  // outputs across blocks). Trim leading/trailing whitespace and
  // newlines because the model occasionally emits a trailing \n
  // despite the system prompt.
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
