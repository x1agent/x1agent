import type { SessionEvent } from "../../domain/event.js";
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

/**
 * Render an event slice into a compact transcript the LLM can read.
 *
 * Public-facing event types only: user messages, agent text, tool calls
 * (just the tool name; arguments are noisy and often contain transient
 * file paths). Skips usage / heartbeat / housekeeping events. We
 * collapse consecutive same-author lines so a chatty agent doesn't blow
 * the prompt budget.
 */
function renderTranscript(events: readonly SessionEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    const line = renderEvent(ev);
    if (line) lines.push(line);
  }
  // Cap total transcript size — Haiku has plenty of context, but no
  // reason to ship 100 KB of tool output for a 1-line summary.
  const joined = lines.join("\n");
  return joined.length > 6000 ? joined.slice(joined.length - 6000) : joined;
}

function renderEvent(ev: SessionEvent): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "user.message":
    case "user.input_response": {
      const text = stringFrom(p, ["text", "answer"]);
      return text ? `user: ${trim(text)}` : null;
    }
    case "agent.text": {
      const text = stringFrom(p, ["text"]);
      return text ? `agent: ${trim(text)}` : null;
    }
    case "agent.tool_call": {
      const name = stringFrom(p, ["name", "tool"]);
      return name ? `agent calls tool: ${name}` : null;
    }
    case "agent.input_request": {
      const text = stringFrom(p, ["text", "question"]);
      return text ? `agent asks: ${trim(text)}` : null;
    }
    case "session.started": {
      const text = stringFrom(p, ["prompt", "task"]);
      return text ? `task: ${trim(text)}` : null;
    }
    default:
      return null;
  }
}

function stringFrom(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function trim(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 400
    ? `${collapsed.slice(0, 400)}…`
    : collapsed;
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
