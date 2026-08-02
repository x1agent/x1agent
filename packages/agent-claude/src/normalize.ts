/**
 * Normalize raw Claude Agent SDK messages into the wire events the UI
 * consumes. Each emission is a `{ type, payload }` pair; see
 * docs/architecture/sessions.md for the event catalogue.
 */

export interface NormalizedEvent {
  type: string;
  payload: unknown;
}

export function normalizeMessage(
  message: unknown,
): NormalizedEvent | NormalizedEvent[] | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { type?: string };

  switch (m.type) {
    case "system": {
      const sub = (message as { subtype?: string }).subtype;
      if (sub !== "init") return null;
      return {
        type: "session.init",
        payload: {
          mcp_servers: (message as { mcp_servers?: unknown }).mcp_servers ?? [],
          tools: (message as { tools?: unknown }).tools ?? [],
        },
      };
    }

    case "assistant": {
      const blocks =
        (
          message as {
            message?: { content?: Array<Record<string, unknown>> };
          }
        ).message?.content ?? [];
      const events: NormalizedEvent[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          events.push({ type: "agent.text", payload: { text: block.text } });
        } else if (block.type === "tool_use") {
          events.push({
            type: "agent.tool_call",
            payload: {
              tool_name: block.name,
              tool_use_id: block.id,
              input: block.input,
            },
          });
        } else if (block.type === "thinking") {
          events.push({
            type: "agent.thinking",
            payload: { text: block.thinking },
          });
        }
      }
      if (events.length === 0) return null;
      return events.length === 1 ? events[0]! : events;
    }

    case "tool_result": {
      const r = message as {
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      return {
        type: r.is_error ? "agent.tool_error" : "agent.tool_result",
        payload: {
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error,
        },
      };
    }

    case "result": {
      // Final result message of an SDK turn. Carries cumulative token
      // usage for the turn — the api persists this into token_usage so
      // billing + per-workspace × per-agent dashboards have a source
      // of truth. Defensive about field presence: the SDK adds new
      // counters over time (cache fields landed in 2024) and missing
      // fields drop to 0 in the api.
      const r = message as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        model?: string;
        stop_reason?: string;
        duration_ms?: number;
      };
      if (!r.usage) return null;
      return {
        type: "agent.usage",
        payload: {
          model: r.model ?? "unknown",
          input_tokens: r.usage.input_tokens ?? 0,
          output_tokens: r.usage.output_tokens ?? 0,
          cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
          stop_reason: r.stop_reason,
          duration_ms: r.duration_ms,
        },
      };
    }

    default:
      return null;
  }
}
