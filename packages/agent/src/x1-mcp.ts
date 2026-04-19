/**
 * Internal MCP server — the built-in tools every x1agent session exposes
 * to Claude. When Claude calls one of these tools, the handler POSTs an
 * event to the sidecar on localhost:9090, which publishes it to NATS
 * for the session viewer in the browser.
 *
 * Tools:
 *   emit_status        — announce a phase of work
 *   emit_artifact      — show inline content (markdown, code, mermaid)
 *   request_input      — ask the user a question, wait for reply
 *   emit_error         — report a problem
 *   share              — publish a workspace file with rich rendering
 *   request_permission — ask the user to grant a scope
 *   end_session        — declare the session complete
 *
 * Runs as a stdio subprocess of the agent container.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";

async function postToSidecar(type: string, payload: unknown) {
  try {
    await fetch(`${sidecarUrl}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
  } catch (err) {
    console.error(
      `[x1-mcp] sidecar POST failed: ${(err as Error).message}`,
    );
  }
}

const server = new Server(
  { name: "x1agent", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "emit_status",
      description:
        "Announce the current phase of work to the user watching this session. Call this when you start a new stage, make meaningful progress, or hit something worth flagging.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: [
              "starting",
              "researching",
              "analyzing",
              "writing",
              "reviewing",
              "waiting",
              "done",
            ],
            description: "Current phase of work",
          },
          detail: {
            type: "string",
            description: "Short description of what you're doing",
          },
        },
        required: ["status"],
      },
    },
    {
      name: "emit_artifact",
      description:
        "Show inline content in the session UI. For file-backed content (HTML, images, CSV, zip) use `share` instead.\n\nHow each type renders:\n- code: monospace block on dark background. Use only for actual source code.\n- analysis / summary / document / diff / other: rendered Markdown with headings, tables, lists, bold, italic, and inline code. Mermaid fences render as diagrams.\n\nIf the content has Markdown or a Mermaid diagram, use `document` or `analysis` — not `code`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          artifact_type: {
            type: "string",
            enum: [
              "code",
              "analysis",
              "summary",
              "document",
              "diff",
              "other",
            ],
          },
          title: { type: "string" },
          content: { type: "string" },
          language: {
            type: "string",
            description: "Programming language for code artifacts",
          },
          metadata: { type: "object" },
        },
        required: ["artifact_type", "title", "content"],
      },
    },
    {
      name: "request_input",
      description:
        "Ask the user a question. The answer arrives as a new user message with the same `request_id`. After calling this, either keep working on other parallel tasks or end the turn and wait.",
      inputSchema: {
        type: "object" as const,
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of clickable choices",
          },
          request_id: {
            type: "string",
            description: "Unique ID used to match the response",
          },
        },
        required: ["question", "request_id"],
      },
    },
    {
      name: "emit_error",
      description: "Report an error or problem to the user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: { type: "string" },
          recoverable: { type: "boolean" },
        },
        required: ["message", "recoverable"],
      },
    },
    {
      name: "share",
      description:
        "Publish a file or folder from /workspace to persistent storage so the user can view or download it. Renders inline by type: HTML → iframe, image → preview, CSV → table, JSON → tree, Markdown → document, code → syntax-highlighted, zip → download link. The file must already exist at /workspace/{path}.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to /workspace (e.g. 'report.html', 'charts/revenue.png', 'data.csv')",
          },
          title: { type: "string", description: "Display title" },
        },
        required: ["path"],
      },
    },
    {
      name: "request_permission",
      description:
        "Ask the active user to grant one or more permission scopes (e.g. 'git.write', 'calendar.read').\n\nUse only when a gated tool has already failed with a `permission_required` error, or when you know up front you'll need a scope. The user sees a dialog and clicks Allow or Deny; a system message tells you the outcome.\n\nAfter calling this, END YOUR TURN and wait — do not retry the gated operation immediately. When approved a synthetic user message starts a fresh turn. Write justifications from the user's perspective.",
      inputSchema: {
        type: "object" as const,
        properties: {
          scopes: {
            type: "array",
            items: { type: "string" },
          },
          justification: { type: "string" },
          requested_tool: { type: "string" },
          requested_args: { type: "object" },
        },
        required: ["scopes", "justification"],
      },
    },
    {
      name: "end_session",
      description:
        "End this session. Call this only when the user's task is complete and no follow-up is expected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args as Record<string, unknown>;

  switch (name) {
    case "emit_status":
      await postToSidecar("agent.status", a);
      return { content: [{ type: "text" as const, text: "Status reported." }] };

    case "emit_artifact":
      await postToSidecar("agent.artifact", a);
      return {
        content: [
          {
            type: "text" as const,
            text: `Artifact "${String(a?.title ?? "")}" shared with user.`,
          },
        ],
      };

    case "request_input":
      await postToSidecar("agent.input_request", a);
      return {
        content: [
          {
            type: "text" as const,
            text: `Question sent to user. Their response will arrive as a user message with request_id: ${String(a?.request_id ?? "")}`,
          },
        ],
      };

    case "emit_error":
      await postToSidecar("agent.error", a);
      return { content: [{ type: "text" as const, text: "Error reported." }] };

    case "share": {
      const path = String(a?.path ?? "");
      const title = a?.title;
      try {
        const res = await fetch(`${sidecarUrl}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, title }),
        });
        const result = (await res.json()) as {
          ok?: boolean;
          title?: string;
          share_type?: string;
          files?: unknown[];
          error?: string;
        };
        if (result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Shared "${result.title ?? path}" (${result.share_type ?? "file"}) with user. ${result.files?.length ?? 1} file(s).`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Share failed: ${result.error ?? "unknown error"}`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Share failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "request_permission": {
      try {
        const res = await fetch(`${sidecarUrl}/permission/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scopes: a?.scopes ?? [],
            justification: a?.justification ?? "",
            requested_tool: a?.requested_tool,
            requested_args: a?.requested_args,
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `request_permission failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "end_session":
      await postToSidecar("session.completed", {
        result: String(a?.summary ?? "Session ended by agent"),
      });
      setTimeout(() => process.exit(0), 1000);
      return { content: [{ type: "text" as const, text: "Session ending." }] };

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

await server.connect(new StdioServerTransport());
console.error("[x1-mcp] stdio server started");
