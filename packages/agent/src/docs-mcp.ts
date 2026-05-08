/**
 * Docs MCP — Google Docs read/create/replace_text/append_paragraph.
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
  { name: "docs", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_doc",
      description:
        "Read a Google Docs document and return its plaintext content. Strips formatting; useful for the agent to understand and reason about a document. For round-tripping with structure, use the web_view_link to open in browser.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: { type: "string" },
        },
        required: ["document_id"],
        additionalProperties: false,
      },
    },
    {
      name: "create_doc",
      description:
        "Create a new empty Google Docs document with a title. Returns document_id and web_view_link. Optionally place it in a Drive folder.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string" },
          parent_folder_id: {
            type: "string",
            description: "Optional Drive folder to create the doc inside.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    {
      name: "replace_text_in_doc",
      description:
        "Find-and-replace text across the entire body of a Google Docs document. Case-sensitive by default; pass match_case=false for case-insensitive. Returns the count of replacements made.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: { type: "string" },
          find: { type: "string", description: "Text to find." },
          replace: { type: "string", description: "Replacement text." },
          match_case: {
            type: "boolean",
            description: "Defaults to true. Set false for case-insensitive matching.",
          },
        },
        required: ["document_id", "find", "replace"],
        additionalProperties: false,
      },
    },
    {
      name: "append_paragraph_to_doc",
      description:
        "Append a paragraph (with a leading newline) at the end of a Google Docs document. Use this for adding sections, log entries, etc.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: { type: "string" },
          text: { type: "string", description: "Paragraph text. May include newlines for multi-paragraph appends." },
        },
        required: ["document_id", "text"],
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
    case "read_doc":
      path = "/docs/read";
      body = { document_id: a.document_id };
      break;
    case "create_doc":
      path = "/docs/create";
      body = { title: a.title, parent_folder_id: a.parent_folder_id };
      break;
    case "replace_text_in_doc":
      path = "/docs/replace_text";
      body = {
        document_id: a.document_id,
        find: a.find,
        replace: a.replace,
        match_case: a.match_case,
      };
      break;
    case "append_paragraph_to_doc":
      path = "/docs/append_paragraph";
      body = { document_id: a.document_id, text: a.text };
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
