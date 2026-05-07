/**
 * `files` provider MCP — Drive (today) / OneDrive (later) tools the
 * agent can call to read files in the user's connected file provider.
 *
 * Each tool POSTs to the sidecar's /files/* routes; the sidecar
 * publishes a NATS request to the subscribed provider deployment
 * (google-workspace, microsoft-365, …); the provider mints a fresh
 * user OAuth token from the api's credential proxy, calls the
 * provider's API, and replies. The agent never holds the token and
 * never knows which backend is currently serving the `files` domain.
 *
 * Runs as a stdio subprocess of the agent container, registered via
 * mcpServers in run.ts.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";

async function postToSidecar(
  path: string,
  payload: unknown,
): Promise<{ ok: boolean; body: unknown; status: number }> {
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
      // non-JSON reply; surface as raw text on the body
      body = { ok: false, error: { code: "non_json_reply", message: "sidecar returned non-JSON body" } };
    }
    return { ok: res.ok, body, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {
        ok: false,
        error: {
          code: "sidecar_unreachable",
          message: (err as Error).message,
        },
      },
    };
  }
}

const server = new Server(
  { name: "files", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_files",
      description:
        "List files in the user's connected file provider (Google Drive today). Optional Drive query string narrows the result. Returns id, name, mime_type, modified_time, web_view_link for each file. The user MUST have connected their Google account and granted the drive.readonly scope; if they haven't, this returns permission_required and you should ask the user to connect via the workspace integrations page.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description:
              "Drive v3 search query. Examples: \"name contains 'invoice'\", \"mimeType='application/pdf'\", \"modifiedTime > '2026-01-01'\". Combine with `and`. Omit to list root.",
          },
          page_size: {
            type: "number",
            description: "Max results (1-1000). Defaults to 50.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_file",
      description:
        "Get metadata for a single file by id. Returns the same shape as list_files entries.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: {
            type: "string",
            description: "The file's id (from list_files).",
          },
        },
        required: ["file_id"],
        additionalProperties: false,
      },
    },
    {
      name: "download_file",
      description:
        "Download a file's bytes (base64-encoded). Caps at ~20 MB; for large files use list_files to find the web_view_link instead. Native Google formats (Docs, Sheets, Slides) cannot be downloaded as bytes — use the documents tools to read structured content instead (when available).",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: {
            type: "string",
            description: "The file's id (from list_files).",
          },
        },
        required: ["file_id"],
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
    case "list_files":
      path = "/files/list";
      body = {
        query: a.query as string | undefined,
        page_size: a.page_size as number | undefined,
      };
      break;
    case "get_file":
      path = "/files/get";
      body = { file_id: a.file_id as string };
      break;
    case "download_file":
      path = "/files/download";
      body = { file_id: a.file_id as string };
      break;
    default:
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
  }

  const result = await postToSidecar(path, body);
  // The sidecar relays the provider's reply verbatim; provider errors
  // (permission_required, drive_api_error) come back as { ok: false,
  // error: {...} } and we surface them as MCP tool errors so the LLM
  // sees them and can react (e.g. ask the user to re-consent).
  const replyText = JSON.stringify(result.body, null, 2);
  const isError =
    !result.ok ||
    (typeof result.body === "object" &&
      result.body !== null &&
      "ok" in result.body &&
      (result.body as { ok: boolean }).ok === false);
  return {
    content: [{ type: "text", text: replyText }],
    isError,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
