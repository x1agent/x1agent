import type { Clock } from "@x1agent/kernel";
import type { SessionId } from "../domain/session.js";
import type { SessionEventRepository } from "../ports/session-event-repository.js";
import type { SessionRepository } from "../ports/session-repository.js";
import type { SessionSummarizer } from "../ports/session-summarizer.js";

export interface MaybeUpdateSessionSummaryDeps {
  sessions: SessionRepository;
  events: SessionEventRepository;
  summarizer: SessionSummarizer;
  clock: Clock;
}

export interface MaybeUpdateSessionSummaryConfig {
  /**
   * Don't (re)summarize until at least this many new events have
   * landed since the previous summary. Conservative default keeps
   * token spend low. Tunable via env at composition.
   */
  eventsThreshold: number;
  /**
   * Don't (re)summarize unless at least this many ms have passed
   * since the previous summary. Pairs with the events threshold so
   * a slow trickle of events still gets a refresh eventually, and a
   * burst of events gets one update rather than 50.
   */
  intervalMs: number;
  /**
   * How many trailing events to feed into the summarizer prompt.
   */
  windowSize: number;
}

export const DEFAULT_SUMMARY_CONFIG: MaybeUpdateSessionSummaryConfig = {
  eventsThreshold: 10,
  intervalMs: 5 * 60 * 1000,
  windowSize: 30,
};

export interface MaybeUpdateSessionSummaryInput {
  sessionId: SessionId;
  /**
   * Sequence number of the event that just arrived. Used to compute
   * "are we 10+ events past the last summary?" without a SELECT
   * COUNT — the event-seq column on sessions is the watermark.
   */
  currentSeq: number;
}

export type MaybeUpdateSessionSummaryResult =
  | { kind: "skipped"; reason: "cooldown" | "no-session" | "empty-summary" }
  | { kind: "updated"; summary: string; eventSeq: number };

/**
 * Periodic, best-effort session-summary refresh. Called from the api's
 * NATS subscriber after every successful event append. The event-count
 * + wall-clock cooldown keeps token spend low; the summarizer itself
 * is allowed to return null (no creds, thin events, upstream error)
 * without raising.
 *
 * Does NOT throw — every failure path returns a `skipped` result so
 * the caller can `void`-await without try/catch noise. Errors are
 * logged via console.warn inside the adapter.
 */
export async function maybeUpdateSessionSummary(
  deps: MaybeUpdateSessionSummaryDeps,
  cfg: MaybeUpdateSessionSummaryConfig,
  input: MaybeUpdateSessionSummaryInput,
): Promise<MaybeUpdateSessionSummaryResult> {
  const session = await deps.sessions.findById(input.sessionId);
  if (!session) return { kind: "skipped", reason: "no-session" };

  const now = deps.clock.now();
  const lastSeq = session.summaryEventSeq;
  const lastAt = session.summaryUpdatedAt;
  const haveSummary = session.summary !== null;

  if (haveSummary && lastSeq !== null && lastAt !== null) {
    const seqDelta = input.currentSeq - lastSeq;
    const ageMs = now.getTime() - lastAt.getTime();
    const eventsTriggered = seqDelta >= cfg.eventsThreshold;
    const intervalTriggered = ageMs >= cfg.intervalMs;
    // Need BOTH thresholds violated? No — whichever fires first.
    // But to avoid running too often when the events trigger fires on
    // every NATS message after a quiet stretch, also require that the
    // latest seq is strictly past the last summary's seq.
    if (!(eventsTriggered || intervalTriggered)) {
      return { kind: "skipped", reason: "cooldown" };
    }
    if (seqDelta <= 0) {
      return { kind: "skipped", reason: "cooldown" };
    }
  }

  // listBySession is seq-ASC with `seq > afterSeq` and a LIMIT, so the
  // way to get the *trailing* window is to ask for "everything past
  // currentSeq - windowSize". Anything older than that is summary bait
  // we don't need; we additionally clip on the upper bound so racey
  // out-of-order delivery (an event with seq > currentSeq landed
  // concurrently) doesn't bleed into this prompt.
  const afterSeq = Math.max(-1, input.currentSeq - cfg.windowSize);
  const recent = await deps.events.listBySession(input.sessionId, {
    afterSeq,
    limit: cfg.windowSize,
  });
  const trailing = recent.filter((e) => e.seq <= input.currentSeq);

  const summary = await deps.summarizer.summarize(trailing);
  if (!summary) return { kind: "skipped", reason: "empty-summary" };

  // Watermark = the seq we just summarized "up through". Always
  // currentSeq, not trailing.last.seq, so the cooldown semantics are
  // "10 events since the last summary call" rather than "10 events
  // since the latest event the prompt happened to see".
  const eventSeq = input.currentSeq;
  await deps.sessions.updateSummary(input.sessionId, summary, eventSeq, now);
  return { kind: "updated", summary, eventSeq };
}
