import { connect, StringCodec, type NatsConnection } from "nats";
import {
  SessionId,
  appendSessionEvent,
  type SessionEventRepository,
  type SessionRepository,
  type TokenUsageRepository,
} from "@x1agent/domain-sessions";
import type { AgentRepository } from "@x1agent/domain-agents";
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
}

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
      const sessionId = SessionId(parsed.session_id);
      try {
        await appendSessionEvent(
          { events: opts.events },
          {
            sessionId,
            seq: parsed.sequence,
            type: parsed.type,
            payload: parsed.payload ?? {},
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
