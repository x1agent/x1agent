/**
 * Translate raw Codex JSONL events into the platform wire events the rest
 * of x1agent already consumes (SSE → sidecar → NATS → api subscriber).
 *
 * The Codex CLI emits one JSON object per stdout line when invoked with
 * `codex exec --json`. Two layers of event shape exist:
 *
 *   1. Top-level envelope event_type: `thread.started`, `turn.started`,
 *      `turn.completed`, `turn.failed`, `item.started`, `item.updated`,
 *      `item.completed`, `error`.
 *   2. For item.* events, an inner `item.type` discriminates the kind
 *      of work: `agent_message`, `reasoning`, `command_execution`,
 *      `file_change`, `mcp_tool_call`, `web_search`, `todo_list`,
 *      `error`.
 *
 * Mapping table (mirrors codex-spike-gap-analysis.md §2):
 *
 *   thread.started                      → session.init
 *   turn.started                        → (drop — implied by next item)
 *   item.completed[agent_message]       → agent.text
 *   item.completed[reasoning]           → agent.thinking
 *   item.completed[command_execution]   → agent.tool_call + agent.tool_result
 *                                         (tool_name `bash`)
 *   item.completed[file_change]         → agent.tool_call + agent.tool_result
 *                                         (tool_name `edit`)
 *   item.completed[mcp_tool_call]       → agent.tool_call + agent.tool_result
 *                                         (tool_name passed through)
 *   item.completed[web_search]          → agent.tool_call + agent.tool_result
 *                                         (tool_name `web_search`)
 *   item.completed[todo_list]           → agent.artifact (artifact_type `document`)
 *   turn.completed                      → (v0: log only — agent.usage deferred)
 *   turn.failed / error                 → agent.error
 *
 * v0 deliberately skips streaming deltas: item.started/item.updated are
 * ignored, item.completed produces one platform event per item. The
 * Claude harness emits per-block, so per-completed-item matches that
 * granularity.
 */

export interface NormalizedEvent {
  type: string;
  payload: unknown;
}

export interface NormalizeOptions {
  /**
   * v0 emits a log line per turn.completed with `usage` rather than an
   * `agent.usage` event, because cost-rollup pricing tables don't yet
   * carry OpenAI model rows. Pass a logger to capture it; defaults to
   * console.log.
   */
  logUsage?: (msg: string) => void;
}

interface CodexEnvelope {
  type?: string;
  msg?: { type?: string; [k: string]: unknown };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    content?: string;
    command?: string;
    output?: string;
    exit_code?: number;
    path?: string;
    diff?: string;
    server?: string;
    tool?: string;
    name?: string;
    arguments?: unknown;
    result?: unknown;
    query?: string;
    results?: unknown;
    items?: unknown;
    error?: string;
    [k: string]: unknown;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    [k: string]: unknown;
  };
  model?: string;
  error?: unknown;
  message?: string;
  [k: string]: unknown;
}

/**
 * Codex JSONL parsers in the wild use two slightly different envelopes:
 *
 *   { "type": "item.completed", "item": { ... } }
 *   { "msg": { "type": "item.completed", "item": { ... } } }
 *
 * The second is what `codex exec --json` emits today; the first is what
 * the App Server SDK exposes. Normalise both upfront so the rest of
 * this file only deals with the flat shape.
 */
function flatten(raw: CodexEnvelope): CodexEnvelope {
  const method = raw["method"];
  const params = raw["params"];
  if (typeof method === "string" && params && typeof params === "object") {
    const p = params as Record<string, unknown>;
    if (method === "item/completed") return { ...raw, type: "item.completed", item: p.item as CodexEnvelope["item"] };
    if (method === "turn/completed") return { ...raw, type: "turn.completed", ...p };
    if (method === "error") return { ...raw, type: "error", ...p };
  }
  if (raw.msg && typeof raw.msg === "object" && raw.msg.type) {
    return { ...raw.msg, ...raw, type: raw.msg.type };
  }
  return raw;
}

export function normalizeCodexEvent(
  raw: unknown,
  opts: NormalizeOptions = {},
): NormalizedEvent | NormalizedEvent[] | null {
  if (!raw || typeof raw !== "object") return null;
  const env = flatten(raw as CodexEnvelope);
  const log = opts.logUsage ?? ((m: string) => console.log(m));

  switch (env.type) {
    case "thread.started":
    case "session_configured": {
      return {
        type: "session.init",
        payload: {
          mcp_servers: [],
          tools: [],
        },
      };
    }

    case "turn.started":
    case "task_started":
      return null;

    case "item.started":
    case "item.updated":
      // v0 collapses streaming deltas — only item.completed produces a
      // platform event, matching the Claude harness's per-block
      // granularity. Coarser than ideal for live UX; revisit when we
      // move to the App Server path.
      return null;

    case "item.completed": {
      const item = env.item ?? {};
      const itemId = item.id ?? `codex-item-${Date.now()}`;

      switch (item.type) {
        case "agent_message": {
          const text =
            typeof item.text === "string"
              ? item.text
              : typeof item.content === "string"
                ? item.content
                : "";
          if (!text) return null;
          return { type: "agent.text", payload: { text } };
        }

        // Current app-server v2 uses camelCase item discriminators and
        // streams the actual message through item/agentMessage/delta.
        // The completed item is therefore intentionally not emitted here,
        // otherwise every assistant message would appear twice.
        case "agentMessage":
          return null;

        case "commandExecution": {
          return [
            { type: "agent.tool_call", payload: { tool_name: "bash", tool_use_id: itemId, input: { command: item.command ?? "" } } },
            { type: "agent.tool_result", payload: { tool_use_id: itemId, content: item.aggregatedOutput ?? "", is_error: item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0) } },
          ];
        }

        case "fileChange": {
          return [
            { type: "agent.tool_call", payload: { tool_name: "edit", tool_use_id: itemId, input: { changes: item.changes ?? [] } } },
            { type: "agent.tool_result", payload: { tool_use_id: itemId, content: item.changes ?? [], is_error: item.status === "failed" } },
          ];
        }

        case "mcpToolCall": {
          return [
            { type: "agent.tool_call", payload: { tool_name: item.tool ?? "unknown_mcp_tool", tool_use_id: itemId, input: item.arguments ?? {} } },
            { type: "agent.tool_result", payload: { tool_use_id: itemId, content: item.result ?? item.error ?? "", is_error: Boolean(item.error) || item.status === "failed" } },
          ];
        }

        case "reasoning": {
          const text =
            typeof item.text === "string"
              ? item.text
              : typeof item.content === "string"
                ? item.content
                : "";
          if (!text) return null;
          return { type: "agent.thinking", payload: { text } };
        }

        case "command_execution": {
          return [
            {
              type: "agent.tool_call",
              payload: {
                tool_name: "bash",
                tool_use_id: itemId,
                input: { command: item.command ?? "" },
              },
            },
            {
              type: "agent.tool_result",
              payload: {
                tool_use_id: itemId,
                content: item.output ?? "",
                is_error:
                  typeof item.exit_code === "number" && item.exit_code !== 0,
              },
            },
          ];
        }

        case "file_change": {
          return [
            {
              type: "agent.tool_call",
              payload: {
                tool_name: "edit",
                tool_use_id: itemId,
                input: { path: item.path ?? "" },
              },
            },
            {
              type: "agent.tool_result",
              payload: {
                tool_use_id: itemId,
                content: item.diff ?? "",
                is_error: false,
              },
            },
          ];
        }

        case "mcp_tool_call": {
          // Pass tool_name through verbatim — Codex prefixes its MCP
          // tool names the same way Claude does (mcp__<server>__<name>),
          // so the api subscriber's tool-name handling stays consistent
          // across runtimes.
          const toolName =
            typeof item.tool === "string"
              ? item.tool
              : typeof item.name === "string"
                ? item.name
                : "unknown_mcp_tool";
          return [
            {
              type: "agent.tool_call",
              payload: {
                tool_name: toolName,
                tool_use_id: itemId,
                input: item.arguments ?? {},
              },
            },
            {
              type: "agent.tool_result",
              payload: {
                tool_use_id: itemId,
                content: item.result ?? "",
                is_error: Boolean(item.error),
              },
            },
          ];
        }

        case "web_search": {
          return [
            {
              type: "agent.tool_call",
              payload: {
                tool_name: "web_search",
                tool_use_id: itemId,
                input: { query: item.query ?? "" },
              },
            },
            {
              type: "agent.tool_result",
              payload: {
                tool_use_id: itemId,
                content: item.results ?? "",
                is_error: false,
              },
            },
          ];
        }

        case "todo_list": {
          return {
            type: "agent.artifact",
            payload: {
              artifact_type: "document",
              title: "Todo list",
              content: JSON.stringify(item.items ?? [], null, 2),
            },
          };
        }

        case "error": {
          return {
            type: "agent.error",
            payload: {
              message: item.error ?? "codex item error",
              recoverable: false,
            },
          };
        }

        default:
          return null;
      }
    }

    case "turn.completed":
    case "task_complete": {
      // v0: log usage rather than emit agent.usage. The api's cost
      // recorder only has Anthropic pricing rows today; emitting an
      // agent.usage with `model: "gpt-5.3-codex"` would crash the
      // rollup. Logging keeps it visible in pod stdout for the spike.
      const u = env.usage ?? {};
      const model = env.model ?? "gpt-5.3-codex";
      log(
        `[codex] turn.completed model=${model} input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0} cached=${u.cached_input_tokens ?? 0}`,
      );
      return null;
    }

    case "turn.failed":
    case "error": {
      const msg =
        typeof env.message === "string"
          ? env.message
          : typeof env.error === "string"
            ? env.error
            : "codex turn failed";
      return {
        type: "agent.error",
        payload: { message: msg, recoverable: false },
      };
    }

    default:
      return null;
  }
}

export function normalizeCodexNotification(
  method: string,
  params: Record<string, unknown>,
): NormalizedEvent | NormalizedEvent[] | null {
  if (method === "item/agentMessage/delta") {
    return typeof params.delta === "string" && params.delta
      ? { type: "agent.text", payload: { text: params.delta } }
      : null;
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    return typeof params.delta === "string" && params.delta
      ? { type: "agent.thinking", payload: { text: params.delta } }
      : null;
  }
  if (method === "item/completed" || method === "turn/completed" || method === "error") {
    return normalizeCodexEvent({ method, params });
  }
  if (method === "thread/started") {
    return { type: "session.init", payload: { mcp_servers: [], tools: [] } };
  }
  return null;
}
