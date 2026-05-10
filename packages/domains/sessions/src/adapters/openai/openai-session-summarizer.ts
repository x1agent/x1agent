import type { SessionEvent } from "../../domain/event.js";
import { renderTranscript } from "../../domain/render-transcript.js";
import type { SessionSummarizer } from "../../ports/session-summarizer.js";

/**
 * SessionSummarizer adapter that calls api.openai.com directly.
 *
 * Sibling to AnthropicSessionSummarizer; pick whichever your install
 * has a key for. Same null-on-error contract: every failure mode
 * (network, 4xx, 5xx, malformed JSON) returns null so a flaky LLM
 * can never take down event ingestion.
 *
 * Why a thin fetch instead of the OpenAI SDK: the summarizer is
 * best-effort, the request shape is a single chat-completions call,
 * and adding an SDK dependency for one endpoint costs more than the
 * ~30 lines of fetch we save.
 */
export interface OpenAISessionSummarizerOptions {
  /** OpenAI API key (sk-…). When absent, summarize() no-ops. */
  apiKey: string;
  /**
   * Model id to call. Defaults to `gpt-4o-mini` because summary
   * generation is high-volume and low-stakes — gpt-4o-mini is the
   * right cost / latency point and matches the Haiku-tier we use on
   * the Anthropic side. Override via env if a deployment wants a
   * different tier.
   */
  model?: string;
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override the upstream base URL. Defaults to api.openai.com. */
  baseUrl?: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com";
const MAX_SUMMARY_CHARS = 120;

const SYSTEM_PROMPT = [
  "You produce one-line descriptions of in-progress agent sessions.",
  "Output ONLY the description. No prefixes, no quotes, no markdown,",
  "no trailing punctuation. Maximum 100 characters. Active voice,",
  "present tense. Focus on the user's apparent goal, not the agent's",
  "internal mechanics.",
].join(" ");

export class OpenAISessionSummarizer implements SessionSummarizer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: OpenAISessionSummarizerOptions) {
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
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 80,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
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
        `[summarizer] openai fetch failed: ${(err as Error).message}`,
      );
      return null;
    }
    if (!res.ok) {
      const body = await safeReadBody(res);
      console.warn(
        `[summarizer] openai /v1/chat/completions returned ${res.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      console.warn(
        `[summarizer] openai JSON parse failed: ${(err as Error).message}`,
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
  const j = json as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  if (!Array.isArray(j.choices) || j.choices.length === 0) return null;
  const content = j.choices[0]?.message?.content;
  if (typeof content !== "string") return null;
  const text = content.trim();
  return text || null;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
