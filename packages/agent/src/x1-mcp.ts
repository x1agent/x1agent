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
        "Show inline content to the user in the session UI. For file-backed content (HTML, images, CSV, etc.), use the `share` tool instead.\n\nHow each type renders:\n- **code**: raw monospace text on dark background. Use ONLY for actual source code snippets.\n- **analysis**: rendered Markdown with headings, lists, tables, bold/italic.\n- **summary**: rendered Markdown. Use for executive summaries or conclusions.\n- **document**: rendered Markdown. Use for reports, Mermaid diagrams, or any formatted text.\n- **diff**: rendered Markdown. Use for showing changes.\n- **other**: rendered Markdown.\n\nIMPORTANT: If the content contains Markdown formatting (headings, tables, lists, Mermaid diagrams), use 'document' or 'analysis' — NOT 'code'. Only use 'code' for actual programming language source code.",
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
        "Share a file or folder from /workspace with the user. The content is uploaded to persistent storage and displayed inline in the session UI. Use this for any output the user should see or download.\n\nSupported types and how they render:\n- HTML (.html or folder with index.html) → interactive iframe. Relative CSS/JS/image refs work.\n- Images (.png, .jpg, .svg, .gif, .webp) → inline image preview\n- CSV (.csv) → interactive data table\n- JSON/JSONL (.json, .jsonl) → expandable JSON tree viewer\n- Markdown (.md) → rendered document\n- Code (.ts, .py, .rs, etc.) → syntax-highlighted code block\n- ZIP (.zip) → download link\n\nThe file must already exist at /workspace/{path} before calling share. Typical flow: write the file with the Write tool, then call share. Shares are persistent — they survive past the session and show up on the workspace Shares page.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to /workspace (e.g. 'output/report.html', 'charts/revenue.png', 'data.csv')",
          },
          title: {
            type: "string",
            description: "Short display title for the share card.",
          },
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
      name: "list_collections",
      description:
        "List the knowledge collections this session can read and write. Returns [{id, slug, backend_handle, provider_type, is_default}]. The default is the write target for graph_write / vector_upsert when you don't pass an explicit `collection`.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "graph_query",
      description:
        "Run a read-only SurrealQL query against a collection. Pass `collection` as a slug ('ideas') or id; omit to hit the default. Returns the raw provider result under `result.rows`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          query: { type: "string" },
          vars: { type: "object" },
        },
        required: ["query"],
      },
    },
    {
      name: "graph_write",
      description:
        "Create a record in a collection with provenance automatically stamped (session + confidence + source + derived_from). `record_type` is a slug ('person', 'decision', or a new one the agent introduces). `data` is the record's fields; provenance goes to `_provenance` under the hood.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          record_type: { type: "string" },
          data: { type: "object" },
          confidence: {
            type: "number",
            description: "0..1 self-reported confidence in the fact. Default 1.",
          },
          source: {
            type: "string",
            description: "Free-form origin of the fact — URL, doc id, 'manual'.",
          },
          derived_from: {
            type: "array",
            items: { type: "string" },
            description: "Ids of other records this one came from.",
          },
        },
        required: ["record_type", "data"],
      },
    },
    {
      name: "graph_relate",
      description:
        "Create an edge between two existing records. `from` and `to` are record ids (the full 'table:hash' SurrealDB returns), `edge` is the label ('WORKS_ON', 'PART_OF').",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          from: { type: "string" },
          edge: { type: "string" },
          to: { type: "string" },
          properties: { type: "object" },
        },
        required: ["from", "edge", "to"],
      },
    },
    {
      name: "graph_resolve",
      description:
        "Look up a single record by fuzzy hints (name + email + attributes, OR-matched). Returns `null` if nothing matches. Use before graph_write to avoid duplicating a person / org you already recorded.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          record_type: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          attributes: { type: "object" },
        },
        required: ["record_type"],
      },
    },
    {
      name: "graph_discover",
      description:
        "List every record type registered in a collection — the default seed types plus any the agent introduced. Use before picking `record_type` for a write.",
      inputSchema: {
        type: "object" as const,
        properties: { collection: { type: "string" } },
      },
    },
    {
      name: "vector_upsert",
      description:
        "Write an embedding into a collection's vector store. `id` is caller-supplied and idempotent (re-upsert replaces). Vector dimension must match what the collection was provisioned with.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          id: { type: "string" },
          vector: { type: "array", items: { type: "number" } },
          metadata: { type: "object" },
        },
        required: ["id", "vector"],
      },
    },
    {
      name: "vector_search",
      description:
        "Top-K nearest-neighbour search. Returns [{id, score, metadata}] ranked so higher score = better match regardless of distance metric. `filter` is an AND of metadata equality predicates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          vector: { type: "array", items: { type: "number" } },
          top_k: { type: "number" },
          filter: { type: "object" },
        },
        required: ["vector"],
      },
    },
    {
      name: "vector_delete",
      description: "Remove a vector by caller-supplied id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "post_message",
      description:
        "Send a message to a channel via the workspace's messaging provider (Slack, Teams, etc — set by platform config). Channel format depends on the provider — Slack accepts #channel, @user, or the raw Cxxxx id. Returns { ok, message_id, channel, posted_at } or { ok: false, error }. Common error codes: channel_not_found, messaging_unauthorized, messaging_provider_unreachable, provider_timeout.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description:
              "Channel id or alias (#ops, @alice, Cxxxx for Slack)",
          },
          text: { type: "string" },
          thread_id: {
            type: "string",
            description:
              "Optional thread reference (Slack thread_ts, Teams replyToId)",
          },
          username: {
            type: "string",
            description:
              "Optional display-name override where the provider supports it",
          },
        },
        required: ["channel", "text"],
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
    {
      name: "message_caller",
      description:
        "Push an explicit signal up to the session that spawned you. Use when you want to notify your parent orchestrator of a milestone, an ask, or a blocker — not for every progress update (use emit_status for cheap heartbeats). The platform routes this as a driverless wake into the parent's turn so the parent reasons about your signal without polling. Only works when this session has a parent (was spawned by another agent). Returns { ok, delivered }. delivered=false with reason='parent_not_orchestrator' means your parent is a worker and platform wakes aren't routed there; the call still succeeded as a no-op.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: {
            type: "string",
            description:
              "Short, parent-readable signal (one line). This is what the parent reads first.",
          },
          body: {
            type: "string",
            description:
              "Optional longer detail — commit SHAs, file references, evidence for a decision.",
          },
          needs_response: {
            type: "boolean",
            description:
              "True if you're blocked and need the parent to inject_message back to you. False if you're just reporting status and will keep working.",
          },
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
        // Read as text first so we can surface a useful message even
        // when the sidecar returns an empty body — that happens when
        // the binary predates the /share route and axum's default
        // 404 handler responds with a bare status line.
        const bodyText = await res.text();
        let result: {
          ok?: boolean;
          title?: string;
          share_type?: string;
          files?: unknown[];
          error?: string;
        } = {};
        if (bodyText) {
          try {
            result = JSON.parse(bodyText);
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Share failed: sidecar returned non-JSON (${res.status}): ${bodyText.slice(0, 200)}`,
                },
              ],
              isError: true,
            };
          }
        }
        if (!res.ok || !result.ok) {
          const hint =
            res.status === 404
              ? " — sidecar is missing the /share route (image likely predates the share subsystem; rebuild required)"
              : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `Share failed (${res.status}): ${result.error ?? bodyText.slice(0, 200) ?? "unknown error"}${hint}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Shared "${result.title ?? path}" (${result.share_type ?? "file"}) with user. ${result.files?.length ?? 1} file(s).`,
            },
          ],
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

    case "list_collections": {
      try {
        const res = await fetch(`${sidecarUrl}/collections`);
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
              text: `list_collections failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "graph_query":
    case "graph_write":
    case "graph_relate":
    case "graph_resolve":
    case "graph_discover":
    case "vector_upsert":
    case "vector_search":
    case "vector_delete": {
      // Every graph_*/vector_* tool maps to the same-named sidecar
      // route with the same body shape, so a single switch arm
      // covers them all. Sidecar validates collection attachment
      // and forwards to NATS.
      const [domain, action] = name.split("_");
      try {
        const res = await fetch(`${sidecarUrl}/${domain}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(a ?? {}),
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
              text: `${name} failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "post_message": {
      try {
        const res = await fetch(`${sidecarUrl}/messaging/post_message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: String(a?.channel ?? ""),
            text: String(a?.text ?? ""),
            thread_id: a?.thread_id,
            username: a?.username,
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
              text: `post_message failed: ${(err as Error).message}`,
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

    case "message_caller": {
      try {
        const res = await fetch(`${sidecarUrl}/message-caller`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: String(a?.summary ?? ""),
            body: a?.body != null ? String(a.body) : null,
            needs_response: a?.needs_response === true,
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
              text: `message_caller failed: ${(err as Error).message}`,
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
