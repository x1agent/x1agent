// initOtel before any auto-instrumented imports.
import { initOtel } from "@x1agent/observability";
initOtel({ serviceName: "x1agent-provider-messaging-slack" });

/**
 * messaging-slack provider service.
 *
 * A standalone deployment that speaks the messaging domain's NATS
 * request/reply contract. The sidecar publishes to
 * `x1.provider.messaging.post_message`; this service handles the
 * request and replies on the NATS inbox subject. The agent pod never
 * holds a Slack token — the service does.
 *
 * Phase 1: single bot token from SLACK_BOT_TOKEN. Phase 2 adds
 * per-workspace OAuth + credential proxy.
 */
import { connect, StringCodec, type Msg, type NatsConnection } from "nats";
import { DomainError } from "@x1agent/kernel";
import {
  ChannelId,
  MessagingUnauthorizedError,
  SlackMessagingProvider,
  type MessagingProvider,
  type PostMessageInput,
} from "@x1agent/domain-messaging";

const NATS_URL = process.env.NATS_URL ?? "nats://nats:4222";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";

if (!SLACK_BOT_TOKEN) {
  console.error(
    "[messaging-slack] SLACK_BOT_TOKEN is not set — every request will reject with messaging_unauthorized.",
  );
}

const provider: MessagingProvider = new SlackMessagingProvider({
  botToken: SLACK_BOT_TOKEN,
});

interface PostMessageRequestBody {
  channel?: string;
  text?: string;
  thread_id?: string;
  username?: string;
}

interface WireReply {
  ok: boolean;
  message_id?: string;
  channel?: string;
  posted_at?: string;
  url?: string | null;
  error?: {
    code: string;
    message: string;
  };
}

function okReply(
  out: Awaited<ReturnType<MessagingProvider["postMessage"]>>,
): WireReply {
  return {
    ok: true,
    message_id: out.providerMessageId,
    channel: out.channel,
    posted_at: out.postedAt.toISOString(),
    url: out.url,
  };
}

function errReply(err: unknown): WireReply {
  if (err instanceof DomainError)
    return { ok: false, error: { code: err.code, message: err.message } };
  return {
    ok: false,
    error: {
      code: "provider_error",
      message: (err as Error)?.message ?? String(err),
    },
  };
}

async function handlePostMessage(
  body: PostMessageRequestBody,
): Promise<WireReply> {
  if (!body.channel || !body.text)
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "channel and text are required",
      },
    };
  if (!SLACK_BOT_TOKEN) {
    return errReply(
      new MessagingUnauthorizedError("slack", "bot token not configured"),
    );
  }
  const input: PostMessageInput = {
    channel: ChannelId(body.channel),
    options: {
      text: body.text,
      threadId: body.thread_id,
      username: body.username,
    },
  };
  try {
    const out = await provider.postMessage(input);
    return okReply(out);
  } catch (err) {
    return errReply(err);
  }
}

function natsOpts() {
  const certFile = process.env.NATS_CLIENT_CERT;
  const keyFile = process.env.NATS_CLIENT_KEY;
  const caFile = process.env.NATS_CA_FILE;
  if (certFile && keyFile && caFile) {
    return { servers: NATS_URL, tls: { certFile, keyFile, caFile } } as const;
  }
  return { servers: NATS_URL } as const;
}

async function main() {
  const nc: NatsConnection = await connect(natsOpts());
  const sc = StringCodec();
  console.log(`[messaging-slack] connected to ${NATS_URL}`);

  const sub = nc.subscribe("x1.provider.messaging.post_message");
  console.log(`[messaging-slack] subscribed to x1.provider.messaging.post_message`);

  (async () => {
    for await (const m of sub as AsyncIterable<Msg>) {
      let body: PostMessageRequestBody = {};
      try {
        body = JSON.parse(sc.decode(m.data)) as PostMessageRequestBody;
      } catch {
        // Fall through with empty body; handler will reject.
      }
      const reply = await handlePostMessage(body);
      if (m.reply) {
        nc.publish(m.reply, sc.encode(JSON.stringify(reply)));
      }
    }
  })().catch((err) => {
    console.error(`[messaging-slack] subscription crashed:`, err);
    process.exit(1);
  });

  const shutdown = async () => {
    console.log("[messaging-slack] shutting down");
    await nc.drain();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
