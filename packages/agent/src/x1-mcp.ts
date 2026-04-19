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
    {
      name: "request_grant",
      description:
        "Ask the user to grant you a capability. One tool for every grant type — spawn, tool_scope, anything future. The user sees an inline Approve / Deny card in their session view; a message tells you the outcome.\n\nShape `details` to the grant_type:\n  - spawn: { child_agent_id: string }\n  - tool_scope: { scope: string }\n\nSet `scope` to:\n  - once: approve exactly one tool call\n  - session: approve for this session only\n  - persistent: standing approval (rare, admin-level)\n\nAfter calling this END YOUR TURN — the response arrives as a user message starting a fresh turn.",
      inputSchema: {
        type: "object" as const,
        properties: {
          request_id: {
            type: "string",
            description: "Unique ID used to match the response",
          },
          grant_type: {
            type: "string",
            enum: ["spawn", "tool_scope"],
          },
          details: {
            type: "object",
            description: "Type-specific payload (see tool description)",
          },
          scope: {
            type: "string",
            enum: ["once", "session", "persistent"],
          },
          justification: {
            type: "string",
            description:
              "One-sentence explanation of why you need this, from the user's perspective.",
          },
        },
        required: [
          "request_id",
          "grant_type",
          "details",
          "scope",
          "justification",
        ],
      },
    },
    {
      name: "list_spawnable_agents",
      description:
        "List the child agents this session is allowed to spawn. Returns [{id, slug, name}]. Empty list means the agent has no spawn grants — ask the user to grant one on the agent edit screen.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "read_child_output",
      description:
        "Read durable events from a session you spawned. Pass child_session_id (returned by spawn_session) and optionally after_seq to page — typical loop: call with after_seq=0 first, then pass back the last seq you saw. Returns { child: {id, status}, events: [{seq, type, payload, timestamp}] }. A 403 means the session isn't yours to read.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_session_id: { type: "string" },
          after_seq: {
            type: "number",
            description:
              "Return only events whose seq is greater than this. Default 0 (all).",
          },
          limit: {
            type: "number",
            description:
              "Max number of events (default 500, cap 5000).",
          },
        },
        required: ["child_session_id"],
      },
    },
    {
      name: "inject_message",
      description:
        "Send a user-message into a session you spawned. Use to drive a child agent — e.g. ask it a follow-up question after reading its output. The child receives it as a new user turn with from_session_id set to your id. Returns { ok, sequence }. A 403 means the session isn't yours to drive.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_session_id: { type: "string" },
          text: { type: "string" },
        },
        required: ["child_session_id", "text"],
      },
    },
    {
      name: "spawn_session",
      description:
        "Start a new session of a child agent. Pass the child_agent_id returned by list_spawnable_agents. Returns {session_id, status}. After spawning, you can watch the child's progress via read_child_output (coming soon) or simply continue with other work — the child runs in its own pod.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_agent_id: {
            type: "string",
            description: "UUID of the child agent to spawn",
          },
        },
        required: ["child_agent_id"],
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

    case "request_grant":
      await postToSidecar("agent.permission_request", a);
      return {
        content: [
          {
            type: "text" as const,
            text: `Grant request sent. User will Approve or Deny; the outcome arrives as a user message with request_id: ${String(a?.request_id ?? "")}`,
          },
        ],
      };

    case "list_spawnable_agents": {
      try {
        const res = await fetch(`${sidecarUrl}/spawnable`);
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
              text: `list_spawnable_agents failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "read_child_output": {
      const childId = String(a?.child_session_id ?? "");
      const qs = new URLSearchParams();
      if (a?.after_seq !== undefined)
        qs.set("after_seq", String(a["after_seq"]));
      if (a?.limit !== undefined) qs.set("limit", String(a["limit"]));
      try {
        const res = await fetch(
          `${sidecarUrl}/child/${encodeURIComponent(childId)}/events${
            qs.toString() ? `?${qs.toString()}` : ""
          }`,
        );
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `read_child_output failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "inject_message": {
      const childId = String(a?.child_session_id ?? "");
      try {
        const res = await fetch(
          `${sidecarUrl}/child/${encodeURIComponent(childId)}/inject`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: String(a?.text ?? "") }),
          },
        );
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `inject_message failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "spawn_session": {
      try {
        const res = await fetch(`${sidecarUrl}/spawn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            child_agent_id: String(a?.child_agent_id ?? ""),
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `spawn_session failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "end_session": {
      // POST to the agent's /shutdown so the parent process terminates
      // cleanly — one session.completed event, no 15-minute idle-timer
      // drift afterwards. Do not exit this subprocess; the agent's
      // shutdown() will kill the container, this MCP included.
      const summary = String(a?.summary ?? "Session ended by agent");
      const agentUrl = process.env.AGENT_INJECT_URL || "http://localhost:8788";
      try {
        await fetch(`${agentUrl}/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary, is_success: true }),
        });
      } catch (err) {
        console.error(
          `[x1-mcp] /shutdown POST failed: ${(err as Error).message}`,
        );
      }
      return { content: [{ type: "text" as const, text: "Session ending." }] };
    }

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

await server.connect(new StdioServerTransport());
console.error("[x1-mcp] stdio server started");
