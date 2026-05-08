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
    {
      name: "upload_file",
      description:
        "Upload a NEW file to Google Drive. Creates a file with the given name and content. Optional parent_folder_id puts it inside a folder; omit for the user's My Drive root. Use this when creating a fresh file. To replace the contents of an existing file, use update_file_content instead. Caps at ~20 MB.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "The new file's display name." },
          parent_folder_id: {
            type: "string",
            description: "Optional Drive folder id to create the file inside. Omit for My Drive root.",
          },
          content_base64: {
            type: "string",
            description: "Base64-encoded file bytes.",
          },
          mime_type: {
            type: "string",
            description: "Optional MIME type (e.g. text/plain, text/markdown). Defaults to application/octet-stream.",
          },
        },
        required: ["name", "content_base64"],
        additionalProperties: false,
      },
    },
    {
      name: "update_file_content",
      description:
        "REPLACE the content bytes of an existing Drive file. Keeps the same file_id, name, parents, and modifiedTime gets bumped. Native Google formats (Docs/Sheets/Slides) can't be written this way — use the documents tools (when available) for those.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "The existing file's id." },
          content_base64: {
            type: "string",
            description: "Base64-encoded new file bytes.",
          },
          mime_type: {
            type: "string",
            description: "Optional new MIME type. Omit to keep the file's current type.",
          },
        },
        required: ["file_id", "content_base64"],
        additionalProperties: false,
      },
    },
    {
      name: "update_file_metadata",
      description:
        "Rename a Drive file or move it to a different folder. Pass `name` to rename, `parent_folder_id` to move (replaces existing parent). At least one of the two is required.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "The file's id." },
          name: { type: "string", description: "Optional new name." },
          parent_folder_id: {
            type: "string",
            description: "Optional new parent folder id. Replaces existing parent.",
          },
        },
        required: ["file_id"],
        additionalProperties: false,
      },
    },
    {
      name: "create_folder",
      description: "Create a new folder in Google Drive. Returns the new folder's id and web_view_link.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Folder name." },
          parent_folder_id: {
            type: "string",
            description: "Optional parent folder id. Omit for My Drive root.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "trash_file",
      description:
        "Move a Drive file to trash. Reversible from the user's Drive UI. Hard delete is intentionally not exposed — agents should never permanently delete user data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "The file's id." },
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
    case "upload_file":
      path = "/files/upload";
      body = {
        name: a.name as string,
        parent_folder_id: a.parent_folder_id as string | undefined,
        content_base64: a.content_base64 as string,
        mime_type: a.mime_type as string | undefined,
      };
      break;
    case "update_file_content":
      path = "/files/update_content";
      body = {
        file_id: a.file_id as string,
        content_base64: a.content_base64 as string,
        mime_type: a.mime_type as string | undefined,
      };
      break;
    case "update_file_metadata":
      path = "/files/update_metadata";
      body = {
        file_id: a.file_id as string,
        name: a.name as string | undefined,
        parent_folder_id: a.parent_folder_id as string | undefined,
      };
      break;
    case "create_folder":
      path = "/files/create_folder";
      body = {
        name: a.name as string,
        parent_folder_id: a.parent_folder_id as string | undefined,
      };
      break;
    case "trash_file":
      path = "/files/trash";
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
