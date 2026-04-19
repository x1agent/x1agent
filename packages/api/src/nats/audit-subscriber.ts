import { connect, StringCodec, type NatsConnection } from "nats";
import type postgres from "postgres";
import { natsConnectOpts } from "../composition/nats-provider-gateway.js";

interface AuditWire {
  session_id?: string;
  ts?: string;
  method?: string;
  route?: string;
  status?: number;
  caller?: string;
}

export interface StartAuditSubscriberOptions {
  natsUrl: string;
  sql: postgres.Sql<Record<string, unknown>>;
}

export interface AuditSubscriber {
  stop(): Promise<void>;
}

/**
 * Subscribe to `x1.session.*.audit`, persist every audit event into
 * audit_events. The sidecar already ensures the session_id matches
 * the pod it lives in; we only validate shape here.
 */
export async function startSessionAuditSubscriber(
  opts: StartAuditSubscriberOptions,
): Promise<AuditSubscriber> {
  const nc: NatsConnection = await connect({
    ...natsConnectOpts(opts.natsUrl),
    name: "x1agent-api-audit-ingester",
    reconnect: true,
    maxReconnectAttempts: -1,
  });
  const sc = StringCodec();
  const subject = "x1.session.*.audit";
  const sub = nc.subscribe(subject);
  console.log(`[audit] subscribed to ${subject}`);

  let running = true;
  (async () => {
    for await (const m of sub) {
      if (!running) break;
      let parsed: AuditWire;
      try {
        parsed = JSON.parse(sc.decode(m.data)) as AuditWire;
      } catch (err) {
        console.warn(
          `[audit] bad JSON on ${m.subject}: ${(err as Error).message}`,
        );
        continue;
      }
      if (
        typeof parsed.session_id !== "string" ||
        typeof parsed.method !== "string" ||
        typeof parsed.route !== "string" ||
        typeof parsed.status !== "number"
      ) {
        continue;
      }
      try {
        await opts.sql`
          INSERT INTO audit_events
            (session_id, ts, method, route, status, caller, metadata)
          VALUES
            (${parsed.session_id},
             ${parsed.ts ? new Date(parsed.ts) : new Date()},
             ${parsed.method},
             ${parsed.route},
             ${parsed.status},
             ${parsed.caller ?? null},
             ${opts.sql.json({})})
        `;
      } catch (err) {
        // Single bad row shouldn't kill the loop. Foreign-key
        // violations (session_id doesn't exist) just get dropped —
        // happens when a session was deleted before its audit
        // events drained.
        const code = (err as { code?: string })?.code;
        if (code !== "23503") {
          console.warn(
            `[audit] persist failed: ${(err as Error).message}`,
          );
        }
      }
    }
  })().catch((err) => {
    console.error(`[audit] subscriber crashed: ${(err as Error).message}`);
  });

  return {
    async stop() {
      running = false;
      await nc.drain();
    },
  };
}
