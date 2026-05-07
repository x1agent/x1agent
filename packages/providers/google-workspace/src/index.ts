// initOtel must run BEFORE any auto-instrumented imports (nats, undici).
import { initOtel } from "@x1agent/observability";
initOtel({ serviceName: "x1agent-provider-google-workspace" });

/**
 * google-workspace provider service.
 *
 * Standalone Kubernetes Deployment that subscribes to the Google
 * Workspace surfaces of the documented provider model:
 *
 *   x1.provider.files.*       — Drive (read paths v1)
 *   x1.provider.documents.*   — Docs + Sheets (Phase 2/3)
 *   x1.provider.calendar.*    — Calendar (Phase 4)
 *   x1.provider.email.*       — Gmail (Phase 5)
 *
 * v1 ships only `files.*` (Drive read). The skeleton is identical for
 * every domain; expanding to documents/calendar/email is per-handler
 * work, not architectural change.
 *
 * Auth: per-call user OAuth via the api's `/api/internal/user-oauth-
 * token` endpoint (Phase 0 substrate). Provider holds the access
 * token only for the duration of one outbound Google API call.
 */

import { connect, StringCodec, type Msg, type NatsConnection } from "nats";
import {
  handleDownload,
  handleGet,
  handleList,
  type DownloadFileRequest,
  type GetFileRequest,
  type ListFilesRequest,
} from "./files.js";

const NATS_URL = process.env.NATS_URL ?? "nats://nats:4222";

function natsOpts() {
  const certFile = process.env.NATS_CLIENT_CERT;
  const keyFile = process.env.NATS_CLIENT_KEY;
  const caFile = process.env.NATS_CA_FILE;
  if (certFile && keyFile && caFile) {
    return { servers: NATS_URL, tls: { certFile, keyFile, caFile } } as const;
  }
  return { servers: NATS_URL } as const;
}

interface NatsHandler<Req> {
  subject: string;
  handle: (req: Req) => Promise<unknown>;
}

const HANDLERS: NatsHandler<unknown>[] = [
  {
    subject: "x1.provider.files.list",
    handle: (req) => handleList(req as ListFilesRequest),
  },
  {
    subject: "x1.provider.files.get",
    handle: (req) => handleGet(req as GetFileRequest),
  },
  {
    subject: "x1.provider.files.download",
    handle: (req) => handleDownload(req as DownloadFileRequest),
  },
];

async function main() {
  const nc: NatsConnection = await connect(natsOpts());
  const sc = StringCodec();
  console.log(`[google-workspace] connected to ${NATS_URL}`);

  for (const handler of HANDLERS) {
    const sub = nc.subscribe(handler.subject);
    console.log(`[google-workspace] subscribed ${handler.subject}`);
    (async () => {
      for await (const m of sub as AsyncIterable<Msg>) {
        let body: unknown = {};
        try {
          body = JSON.parse(sc.decode(m.data));
        } catch {
          // Fall through with empty body; handler returns missing_param.
        }
        let reply: unknown;
        try {
          reply = await handler.handle(body);
        } catch (err) {
          // Non-CredentialError, non-DriveAPIError exceptions are bugs
          // — log loud, surface a generic 500-style reply so callers
          // can't deadlock waiting for a response.
          console.error(
            `[google-workspace] handler crashed on ${handler.subject}:`,
            err,
          );
          reply = {
            ok: false,
            error: {
              code: "provider_crash",
              message: (err as Error).message,
            },
          };
        }
        if (m.reply) {
          nc.publish(m.reply, sc.encode(JSON.stringify(reply)));
        }
      }
    })().catch((err) => {
      console.error(
        `[google-workspace] subscription crashed on ${handler.subject}:`,
        err,
      );
      process.exit(1);
    });
  }

  const shutdown = async () => {
    console.log("[google-workspace] shutting down");
    await nc.drain();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
