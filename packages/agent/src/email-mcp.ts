/**
 * Email (Gmail) MCP — list_threads / get_message / send / trash.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";

async function postToSidecar(path: string, payload: unknown) {
  try {
    const res = await fetch(`${sidecarUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = { ok: false, error: { code: "non_json_reply", message: "non-JSON body" } };
    }
    return { ok: res.ok, body };
  } catch (err) {
    return {
      ok: false,
      body: {
        ok: false,
        error: { code: "sidecar_unreachable", message: (err as Error).message },
      },
    };
  }
}

const server = new Server(
  { name: "email", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_email_threads",
      description:
        "List Gmail threads, optionally filtered by Gmail's search query (q=). Examples: \"is:unread from:foo@example.com\", \"subject:invoice newer_than:7d\", \"label:starred\". Returns thread ids + snippet previews.",
      inputSchema: {
        type: "object" as const,
        properties: {
          q: { type: "string", description: "Gmail search query." },
          max_results: { type: "number", description: "Defaults to 20." },
          page_token: { type: "string", description: "Optional pagination token from a previous call." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_email_message",
      description:
        "Fetch a single Gmail message by id. Returns headers (From/To/Subject/Date/etc.), body_text, snippet, and label_ids.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
        additionalProperties: false,
      },
    },
    {
      name: "send_email",
      description:
        "Send an email from the user's Gmail account. Sets From: header automatically to the user. Pass `reply_to_thread_id` to send as a reply on an existing thread.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string" },
          body: { type: "string", description: "Message body. Set content_type=\"text/html\" if you want HTML." },
          cc: { type: "array", items: { type: "string" } },
          bcc: { type: "array", items: { type: "string" } },
          content_type: {
            type: "string",
            enum: ["text/plain", "text/html"],
            description: "Defaults to text/plain.",
          },
          reply_to_thread_id: {
            type: "string",
            description: "Optional Gmail thread id; sends this as a reply on that thread.",
          },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "trash_email",
      description:
        "Move a Gmail message to Trash. Reversible from the user's Gmail UI. Permanent delete is intentionally not exposed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  let path: string;
  let body: Record<string, unknown>;
  switch (name) {
    case "list_email_threads":
      path = "/email/list_threads";
      body = { q: a.q, max_results: a.max_results, page_token: a.page_token };
      break;
    case "get_email_message":
      path = "/email/get_message";
      body = { message_id: a.message_id };
      break;
    case "send_email":
      path = "/email/send";
      body = {
        to: a.to,
        subject: a.subject,
        body: a.body,
        cc: a.cc,
        bcc: a.bcc,
        content_type: a.content_type,
        reply_to_thread_id: a.reply_to_thread_id,
      };
      break;
    case "trash_email":
      path = "/email/trash";
      body = { message_id: a.message_id };
      break;
    default:
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
  }
  const result = await postToSidecar(path, body);
  const isError =
    !result.ok ||
    (typeof result.body === "object" &&
      result.body !== null &&
      "ok" in result.body &&
      (result.body as { ok: boolean }).ok === false);
  return {
    content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
    isError,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
