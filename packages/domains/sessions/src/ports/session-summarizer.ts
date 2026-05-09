import type { SessionEvent } from "../domain/event.js";

/**
 * Port for the LLM call that turns the recent slice of a session's
 * event log into a short, human-readable description.
 *
 * Sessions today are addressable only by hash; the UI falls back to a
 * truncated id when it needs to render a name. This port is the
 * "what's this session doing?" affordance — one round-trip to the
 * configured AI provider, returning a 1-line summary that the api
 * persists on the `sessions` row.
 *
 * Implementations:
 *   - AnthropicSessionSummarizer (production, uses ANTHROPIC_API_KEY).
 *   - StubSessionSummarizer (composition fallback when no creds; returns
 *     null so the UI falls back to the hash).
 *   - In-memory fakes for tests.
 *
 * The port lives in the sessions domain (not in a shared `ai/` provider
 * package) because the input shape — `SessionEvent[]` — is
 * domain-specific. If a second use case needs free-form text generation
 * later, that's the moment to extract a generic AI port; doing it
 * speculatively now would over-fit on this single caller.
 */
export interface SessionSummarizer {
  /**
   * Returns a 1-line summary (≤ ~100 chars) of what the session is
   * doing, or `null` when:
   *   - the provider is not configured (no creds), or
   *   - the events slice is too thin to summarize (zero meaningful
   *     messages), or
   *   - the upstream call returned non-200 / malformed JSON.
   *
   * Implementations MUST swallow upstream errors and return null
   * instead — the summarizer is best-effort; a flaky LLM should never
   * take down event ingestion.
   */
  summarize(events: readonly SessionEvent[]): Promise<string | null>;
}

/**
 * Default fallback used when no AI provider is configured. Composition
 * wires this when ANTHROPIC_API_KEY is absent so periodic summary
 * triggers stay no-ops (and the UI falls back to the hash) rather than
 * throwing.
 */
export class StubSessionSummarizer implements SessionSummarizer {
  async summarize(): Promise<string | null> {
    return null;
  }
}
