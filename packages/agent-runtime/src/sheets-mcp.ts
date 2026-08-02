/**
 * Sheets MCP — Google Sheets read/write/append/create.
 *
 * Tool descriptions explicitly say "Google Sheets" so the LLM picks
 * these over generic tools when both are present.
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
      body = {
        ok: false,
        error: { code: "non_json_reply", message: "non-JSON body" },
      };
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
  { name: "sheets", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_sheet_range",
      description:
        'Read a range of cells from a Google Sheets spreadsheet. Range uses A1 notation like "Sheet1!A1:C10" or "Tab2!A:A" for a whole column. Returns a 2D array of cell values (strings/numbers/booleans). Empty cells are missing from the array; trailing empty cells are not padded.',
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheet_id: { type: "string" },
          range: {
            type: "string",
            description:
              'A1 notation. Examples: "Sheet1!A1:C10", "Sheet2!B:B".',
          },
        },
        required: ["spreadsheet_id", "range"],
        additionalProperties: false,
      },
    },
    {
      name: "update_sheet_range",
      description:
        "Write a 2D array of values to a Google Sheets range. Overwrites whatever was in those cells. `values[0]` is the first row of the range. Use USER_ENTERED interpretation — formulas like =SUM(A1:A10) are parsed as formulas, not literal text.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheet_id: { type: "string" },
          range: {
            type: "string",
            description: "A1 notation of the target range.",
          },
          values: {
            type: "array",
            description:
              "2D array — outer dim is rows, inner dim is columns. Strings, numbers, and booleans pass through.",
          },
        },
        required: ["spreadsheet_id", "range", "values"],
        additionalProperties: false,
      },
    },
    {
      name: "append_sheet_row",
      description:
        "Append a single row of values to the bottom of a Google Sheets tab. Sheets finds the next empty row automatically. Returns the A1 range that was written.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spreadsheet_id: { type: "string" },
          sheet_name: {
            type: "string",
            description: 'Tab name only — no range. e.g. "Sheet1".',
          },
          values: {
            type: "array",
            description: "1D array of cell values for the new row.",
          },
        },
        required: ["spreadsheet_id", "sheet_name", "values"],
        additionalProperties: false,
      },
    },
    {
      name: "create_spreadsheet",
      description:
        "Create a new Google Sheets spreadsheet with one or more tabs. Returns the new spreadsheet_id and web_view_link.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Spreadsheet display name." },
          sheet_titles: {
            type: "array",
            items: { type: "string" },
            description:
              'Optional initial tab names. Defaults to a single "Sheet1".',
          },
          parent_folder_id: {
            type: "string",
            description:
              "Optional Drive folder id to create the spreadsheet inside.",
          },
        },
        required: ["title"],
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
    case "read_sheet_range":
      path = "/sheets/read_range";
      body = { spreadsheet_id: a.spreadsheet_id, range: a.range };
      break;
    case "update_sheet_range":
      path = "/sheets/update_range";
      body = {
        spreadsheet_id: a.spreadsheet_id,
        range: a.range,
        values: a.values,
      };
      break;
    case "append_sheet_row":
      path = "/sheets/append_row";
      body = {
        spreadsheet_id: a.spreadsheet_id,
        sheet_name: a.sheet_name,
        values: a.values,
      };
      break;
    case "create_spreadsheet":
      path = "/sheets/create";
      body = {
        title: a.title,
        sheet_titles: a.sheet_titles,
        parent_folder_id: a.parent_folder_id,
      };
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
