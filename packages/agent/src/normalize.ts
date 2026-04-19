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
      const blocks = (message as {
        message?: { content?: Array<Record<string, unknown>> };
      }).message?.content ?? [];
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

    default:
      return null;
  }
}
