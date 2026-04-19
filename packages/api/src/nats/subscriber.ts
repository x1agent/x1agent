import { connect, StringCodec, type NatsConnection } from "nats";
import {
  SessionId,
  appendSessionEvent,
  type SessionEventRepository,
  type SessionRepository,
} from "@x1agent/domain-sessions";

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
    servers: opts.natsUrl,
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
            await opts.sessions.updateStatus(sessionId, {
              status: parsed.type === "session.completed" ? "complete" : "failed",
              completedAt: parsed.timestamp
                ? new Date(parsed.timestamp)
                : new Date(),
              errorMessage: payload.error
                ? String(payload.error)
                : typeof payload.result === "string"
                  ? null
                  : null,
            });
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
