import { connect, StringCodec, type NatsConnection } from "nats";
import {
  SessionId,
  appendSessionEvent,
  maybeUpdateSessionSummary,
  DEFAULT_SUMMARY_CONFIG,
  type MaybeUpdateSessionSummaryConfig,
  type SessionEventRepository,
  type SessionRepository,
  type SessionSummarizer,
  type TokenUsageRepository,
} from "@x1agent/domain-sessions";
import type { AgentRepository } from "@x1agent/domain-agents";
import { systemClock } from "@x1agent/kernel";
import { recordTokenUsageMetric } from "@x1agent/observability";
import { natsConnectOpts } from "../composition/nats-provider-gateway.js";
import { publishStateChangeWake } from "../orchestration/wake-publisher.js";

/**
 * Subscribe to `x1.session.*.events`, parse the envelope published by
 * the sidecar (see packages/sidecar/src/nats_bridge.rs), and append
 * each event to Postgres. Idempotent on (session_id, seq).
 *
 * On terminal events (session.completed / session.failed) the
 * subscriber also flips sessions.status to the matching terminal
 * state, so the UI reflects "done" the same instant the event lands
 * in DB. Pods that crash without emitting a terminal event fall
 * through to the K8s Job reaper (see k8s/job-watcher.ts).
 *
 * Runs alongside the scheduler inside the api process. Reconnects are
 * handled by the NATS client itself; we log disconnects and keep going.
 */
export interface StartSubscriberOptions {
  natsUrl: string;
  events: SessionEventRepository;
  sessions: SessionRepository;
  /**
   * Needed to look up the parent agent's `kind` when a child session
   * hits a terminal state — we only fire a state_change wake into
   * orchestrator parents, not worker parents.
   */
  agents: AgentRepository;
  /**
   * Per-turn token usage capture. Written on `agent.usage` events.
   * Optional so older deployments that haven't migrated 021 yet can
   * still ingest events without the subscriber crashing.
   */
  tokenUsage?: TokenUsageRepository;
  /**
   * LLM summarizer for periodic session-description refreshes. When
   * absent, summary generation is skipped — session.summary stays
   * NULL and the UI falls back to the session id hash. Composition
   * wires AnthropicSessionSummarizer when ANTHROPIC_API_KEY is
   * configured, StubSessionSummarizer otherwise.
   */
  summarizer?: SessionSummarizer;
  /**
   * Override the default cooldown thresholds (10 events / 5 min).
   * Composition reads these from env so an operator can tune token
   * spend without a code change. Optional — DEFAULT_SUMMARY_CONFIG
   * applies when absent.
   */
  summaryConfig?: MaybeUpdateSessionSummaryConfig;
}

// Public events — types we want the summarizer to "see". `agent.usage`
// is excluded because it's metering noise; tools-call/result are
// excluded because they explode prompt size for little signal.
const PUBLIC_EVENT_TYPES = new Set([
  "user.message",
  "user.input_response",
  "agent.text",
  "agent.tool_call",
  "agent.input_request",
  "session.started",
]);

/**
 * X1A-103 — transient indicator events that the agent emits over the
 * existing `.events` channel but that must NOT land in `session_events`.
 * They're pure WebSocket fan-out: the frontend (X1A-104) renders a
 * "thinking" indicator; on a page refresh the indicator is gone, so
 * persisting them would just clutter the timeline replay.
 *
 * Keep this list in sync with `TRANSIENT_EVENT_TYPES` in
 * packages/agent/src/wake-classifier.ts. It's duplicated rather than
 * imported because pulling the agent package into the api would drag
 * the whole SDK runtime tree with it.
 */
export const TRANSIENT_EVENT_TYPES = new Set<string>([
  "session.agent_thinking",
  "session.agent_thinking_cancelled",
]);

export interface Subscriber {
  nc: NatsConnection;
  stop: () => Promise<void>;
}

interface WireMessage {
  session_id?: string;
  sequence?: number;
  type?: string;
  payload?: unknown;
  timestamp?: string;
}

/**
 * Stopgap for X1A-43 until session_events grows real `source`,
 * `kind`, `from_session_id` columns. Wake events published by
 * wake-publisher.ts carry that metadata on the NATS .input envelope,
 * but the sidecar→agent SSE round-trip only relays `text`, so the
 * version that lands here (on .events) has just the text. We
 * re-derive `source` and `kind` from the well-known text header so
 * the UI's pill detection has something to match on.
 *
 * Format contract: text starts with `[driverless wake: <header>]`
 * where header is one of the five literals emitted by
 * `format*WakeText` in wake-publisher.ts. Keep this in sync with
 * those literals.
 *
 * The proper fix (real columns + dual-write from wake-publisher) is
 * tracked separately.
 */
export function deriveWakeKindFromText(text: string): string | null {
  if (!text.startsWith("[driverless wake:")) return null;
  const closingBracket = text.indexOf("]");
  if (closingBracket < 0) return null;
  const header = text
    .slice("[driverless wake:".length, closingBracket)
    .trim();
  if (header.startsWith("watchdog")) return "watchdog";
  if (header.startsWith("scheduler heartbeat")) return "heartbeat";
  if (header.startsWith("platform checkup")) return "checkup";
  if (header.startsWith("message from child")) return "message";
  if (
    header.startsWith("child finished") ||
    header.startsWith("child failed") ||
    header.startsWith("child completed") ||
    header.startsWith("child transitioned")
  )
    return "state_change";
  return null;
}

export function enrichWakePayload(
  type: string,
  payload: unknown,
): Record<string, unknown> {
  if (type !== "user.message") {
    return (payload as Record<string, unknown>) ?? {};
  }
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const p = payload as Record<string, unknown>;
  if (p.source || p.kind) return p;
  const text = typeof p.text === "string" ? p.text : "";
  const kind = deriveWakeKindFromText(text);
  if (!kind) return p;
  return { ...p, source: "platform", kind, driverless: true };
}

export async function startSessionEventSubscriber(
  opts: StartSubscriberOptions,
): Promise<Subscriber> {
  const nc = await connect({
    ...natsConnectOpts(opts.natsUrl),
    name: "x1agent-api-event-ingester",
    reconnect: true,
    maxReconnectAttempts: -1,
  });
  const sc = StringCodec();
  const subject = "x1.session.*.events";
  const sub = nc.subscribe(subject);
  console.log(`[nats] subscribed to ${subject}`);

  let running = true;
  (async () => {
    for await (const m of sub) {
      if (!running) break;
      let parsed: WireMessage;
      try {
        parsed = JSON.parse(sc.decode(m.data)) as WireMessage;
      } catch (err) {
        console.warn(
          `[nats] bad JSON on ${m.subject}: ${(err as Error).message}`,
        );
        continue;
      }
      if (
        typeof parsed.session_id !== "string" ||
        typeof parsed.type !== "string" ||
        typeof parsed.sequence !== "number"
      ) {
        console.warn(`[nats] malformed event on ${m.subject}`);
        continue;
      }
      // Derive session_id from the NATS subject, not the body — body
      // is attacker-controllable by any authenticated bus client. The
      // subject is the *routing* identifier and is constrained by the
      // publisher's mTLS cert (today only sidecars publish here, and
      // each sidecar publishes only on its own session's subject).
      // Subject format: `x1.session.<id>.events`. Drop rows where the
      // body claims a different session than the subject routed.
      // See project_nats_subscriber_trust_audit.md.
      const subjectSessionId = m.subject.split(".")[2];
      if (!subjectSessionId || subjectSessionId !== parsed.session_id) {
        console.warn(
          `[nats] subject/body session_id mismatch on ${m.subject} — dropped`,
        );
        continue;
      }
      const sessionId = SessionId(subjectSessionId);

      // X1A-103: transient events flow over `.events` for browser
      // fan-out but are deliberately NOT persisted. Skip BEFORE the
      // appendSessionEvent call so we don't take a Postgres round
      // trip for an event we'll discard. Also skip the summarizer +
      // token-usage paths below — those only apply to durable rows.
      if (TRANSIENT_EVENT_TYPES.has(parsed.type)) {
        continue;
      }

      try {
        await appendSessionEvent(
          { events: opts.events },
          {
            sessionId,
            seq: parsed.sequence,
            type: parsed.type,
            payload: enrichWakePayload(parsed.type, parsed.payload),
            timestamp: parsed.timestamp
              ? new Date(parsed.timestamp)
              : new Date(),
          },
        );
      } catch (err) {
        // `appendSessionEvent` swallows duplicates; any other error
        // means DB connectivity or FK violation (session_id not in
        // sessions table — arrives for a run we never registered).
        // Log and move on; NATS is fire-and-forget.
        console.warn(
          `[nats] failed to persist event type=${parsed.type} seq=${parsed.sequence}: ${(err as Error).message}`,
        );
      }

      // Periodic LLM summary refresh. Bounded by event count + wall
      // clock so a chatty session doesn't generate one summary per
      // turn. Best-effort — every error path inside the summarizer
      // returns null/skipped, never throws. Skip noise events
      // (agent.usage, agent.tool_result, etc.) to keep the trigger
      // count honest.
      if (opts.summarizer && PUBLIC_EVENT_TYPES.has(parsed.type)) {
        try {
          const result = await maybeUpdateSessionSummary(
            {
              sessions: opts.sessions,
              events: opts.events,
              summarizer: opts.summarizer,
              clock: systemClock,
            },
            opts.summaryConfig ?? DEFAULT_SUMMARY_CONFIG,
            { sessionId, currentSeq: parsed.sequence },
          );
          if (result.kind === "updated") {
            console.log(
              `[summarizer] session=${sessionId} seq=${result.eventSeq} summary="${result.summary}"`,
            );
          }
        } catch (err) {
          // maybeUpdateSessionSummary is supposed to swallow upstream
          // errors. A throw means a bug in the persist path — log
          // loudly but keep the subscriber alive.
          console.warn(
            `[summarizer] unexpected throw for session ${sessionId}: ${(err as Error).message}`,
          );
        }
      }

      // Token usage capture. The agent emits one `agent.usage` event
      // per SDK turn (see packages/agent/src/normalize.ts). We persist
      // a denormalized row keyed on (session_id, event_seq) so dashboards
      // can answer "tokens by workspace × agent × day" without touching
      // session_events. Idempotent on dedup index — NATS replays no-op.
      // Session has agentId; the Agent has workspaceId; one extra lookup
      // per usage event is cheap (~1/turn) compared to a tri-table join
      // on every dashboard read.
      if (parsed.type === "agent.usage" && opts.tokenUsage) {
        try {
          const session = await opts.sessions.findById(sessionId);
          if (session) {
            const agent = await opts.agents.findById(session.agentId);
            if (agent) {
              const p = (parsed.payload ?? {}) as {
                model?: string;
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
              const usage = {
                sessionId,
                workspaceId: agent.workspaceId,
                agentId: session.agentId,
                model: p.model ?? "unknown",
                inputTokens: Number(p.input_tokens ?? 0),
                outputTokens: Number(p.output_tokens ?? 0),
                cacheCreationInputTokens: Number(
                  p.cache_creation_input_tokens ?? 0,
                ),
                cacheReadInputTokens: Number(p.cache_read_input_tokens ?? 0),
              };
              await opts.tokenUsage.record({
                ...usage,
                eventSeq: parsed.sequence,
                ts: parsed.timestamp ? new Date(parsed.timestamp) : new Date(),
              });
              // Bridge to OTel — no-op when collector isn't configured.
              recordTokenUsageMetric(usage);
            }
          }
        } catch (err) {
          console.warn(
            `[nats] token_usage write failed for session ${sessionId} seq=${parsed.sequence}: ${(err as Error).message}`,
          );
        }
      }

      // Terminal events flip sessions.status so the UI and listing
      // queries see "done" immediately. Idempotent — running → terminal
      // transitions only, and a second terminal event on the same row
      // is a no-op at the application layer.
      if (
        parsed.type === "session.completed" ||
        parsed.type === "session.failed"
      ) {
        try {
          const session = await opts.sessions.findById(sessionId);
          if (session && session.status !== "complete" && session.status !== "failed") {
            const payload = (parsed.payload ?? {}) as {
              result?: unknown;
              error?: string;
            };
            const terminalStatus =
              parsed.type === "session.completed" ? "complete" : "failed";
            const completedAt = parsed.timestamp
              ? new Date(parsed.timestamp)
              : new Date();
            const errorMessage = payload.error ? String(payload.error) : null;
            await opts.sessions.updateStatus(sessionId, {
              status: terminalStatus,
              completedAt,
              errorMessage,
            });

            // If this session had an orchestrator parent, publish a
            // `state_change` wake so the parent gets re-activated on
            // its next turn. Silent for worker parents, human-spawned
            // sessions, and orphans. See
            // docs/architecture/orchestration.md § Server-driven wakes.
            try {
              await publishStateChangeWake(
                { nc, sessions: opts.sessions, agents: opts.agents },
                session,
                terminalStatus,
                completedAt,
                errorMessage,
              );
            } catch (wakeErr) {
              console.warn(
                `[nats] state_change wake failed for session ${sessionId}: ${(wakeErr as Error).message}`,
              );
            }
          }
        } catch (err) {
          console.warn(
            `[nats] status flip failed for session ${sessionId}: ${(err as Error).message}`,
          );
        }
      }
    }
  })().catch((err) => {
    console.error(`[nats] subscriber loop exited: ${(err as Error).message}`);
  });

  (async () => {
    for await (const status of nc.status()) {
      console.log(`[nats] status: ${status.type}`);
    }
  })().catch(() => {
    // nc.status() iterator completes on close.
  });

  return {
    nc,
    async stop() {
      running = false;
      await sub.unsubscribe();
      await nc.drain();
    },
  };
}
