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
  handleCreateFolder,
  handleDownload,
  handleGet,
  handleList,
  handleTrash,
  handleUpdateContent,
  handleUpdateMetadata,
  handleUpload,
  type CreateFolderRequest,
  type DownloadFileRequest,
  type GetFileRequest,
  type ListFilesRequest,
  type TrashFileRequest,
  type UpdateFileContentRequest,
  type UpdateFileMetadataRequest,
  type UploadFileRequest,
} from "./files.js";
import {
  handleAppendRow,
  handleCreateSpreadsheet,
  handleReadRange,
  handleUpdateRange,
  type AppendSheetRowRequest,
  type CreateSpreadsheetRequest,
  type ReadSheetRangeRequest,
  type UpdateSheetRangeRequest,
} from "./sheets.js";
import {
  handleAppendParagraph,
  handleCreateDoc,
  handleReadDoc,
  handleReplaceText,
  type AppendParagraphRequest,
  type CreateDocRequest,
  type ReadDocRequest,
  type ReplaceTextRequest,
} from "./docs.js";
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleListEvents,
  handleUpdateEvent,
  type CreateEventRequest,
  type DeleteEventRequest,
  type ListEventsRequest,
  type UpdateEventRequest,
} from "./calendar.js";
import {
  handleGetMessage,
  handleListThreads,
  handleSendEmail,
  handleTrashEmail,
  type GetMessageRequest,
  type ListThreadsRequest,
  type SendEmailRequest,
  type TrashEmailRequest,
} from "./email.js";

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
  {
    subject: "x1.provider.files.upload",
    handle: (req) => handleUpload(req as UploadFileRequest),
  },
  {
    subject: "x1.provider.files.update_content",
    handle: (req) => handleUpdateContent(req as UpdateFileContentRequest),
  },
  {
    subject: "x1.provider.files.update_metadata",
    handle: (req) => handleUpdateMetadata(req as UpdateFileMetadataRequest),
  },
  {
    subject: "x1.provider.files.create_folder",
    handle: (req) => handleCreateFolder(req as CreateFolderRequest),
  },
  {
    subject: "x1.provider.files.trash",
    handle: (req) => handleTrash(req as TrashFileRequest),
  },
  // Sheets
  {
    subject: "x1.provider.sheets.read_range",
    handle: (req) => handleReadRange(req as ReadSheetRangeRequest),
  },
  {
    subject: "x1.provider.sheets.update_range",
    handle: (req) => handleUpdateRange(req as UpdateSheetRangeRequest),
  },
  {
    subject: "x1.provider.sheets.append_row",
    handle: (req) => handleAppendRow(req as AppendSheetRowRequest),
  },
  {
    subject: "x1.provider.sheets.create",
    handle: (req) => handleCreateSpreadsheet(req as CreateSpreadsheetRequest),
  },
  // Docs
  {
    subject: "x1.provider.docs.read",
    handle: (req) => handleReadDoc(req as ReadDocRequest),
  },
  {
    subject: "x1.provider.docs.create",
    handle: (req) => handleCreateDoc(req as CreateDocRequest),
  },
  {
    subject: "x1.provider.docs.replace_text",
    handle: (req) => handleReplaceText(req as ReplaceTextRequest),
  },
  {
    subject: "x1.provider.docs.append_paragraph",
    handle: (req) => handleAppendParagraph(req as AppendParagraphRequest),
  },
  // Calendar
  {
    subject: "x1.provider.calendar.list_events",
    handle: (req) => handleListEvents(req as ListEventsRequest),
  },
  {
    subject: "x1.provider.calendar.create_event",
    handle: (req) => handleCreateEvent(req as CreateEventRequest),
  },
  {
    subject: "x1.provider.calendar.update_event",
    handle: (req) => handleUpdateEvent(req as UpdateEventRequest),
  },
  {
    subject: "x1.provider.calendar.delete_event",
    handle: (req) => handleDeleteEvent(req as DeleteEventRequest),
  },
  // Email (Gmail)
  {
    subject: "x1.provider.email.list_threads",
    handle: (req) => handleListThreads(req as ListThreadsRequest),
  },
  {
    subject: "x1.provider.email.get_message",
    handle: (req) => handleGetMessage(req as GetMessageRequest),
  },
  {
    subject: "x1.provider.email.send",
    handle: (req) => handleSendEmail(req as SendEmailRequest),
  },
  {
    subject: "x1.provider.email.trash",
    handle: (req) => handleTrashEmail(req as TrashEmailRequest),
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
