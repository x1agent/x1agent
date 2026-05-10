import type { SessionEvent } from "./event.js";

/**
 * Render an event slice into a compact transcript string an LLM can read.
 *
 * Public-facing event types only: user messages, agent text, tool calls
 * (just the tool name; arguments are noisy and often contain transient
 * file paths). Skips usage / heartbeat / housekeeping events.
 *
 * Provider-agnostic on purpose. Both AnthropicSessionSummarizer and
 * OpenAISessionSummarizer feed the same shape into their respective
 * chat-completions endpoints, so keeping the renderer here means a
 * change to event-rendering rules (e.g. adding a new public event
 * type) lands in one place instead of two adapters drifting apart.
 *
 * Caps the output at 6000 chars by keeping the *tail* of the transcript
 * — recent activity is what we want a 1-line description for.
 */
export function renderTranscript(events: readonly SessionEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    const line = renderEvent(ev);
    if (line) lines.push(line);
  }
  const joined = lines.join("\n");
  return joined.length > 6000 ? joined.slice(joined.length - 6000) : joined;
}

function renderEvent(ev: SessionEvent): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "user.message":
    case "user.input_response": {
      const text = stringFrom(p, ["text", "answer"]);
      return text ? `user: ${trim(text)}` : null;
    }
    case "agent.text": {
      const text = stringFrom(p, ["text"]);
      return text ? `agent: ${trim(text)}` : null;
    }
    case "agent.tool_call": {
      const name = stringFrom(p, ["name", "tool"]);
      return name ? `agent calls tool: ${name}` : null;
    }
    case "agent.input_request": {
      const text = stringFrom(p, ["text", "question"]);
      return text ? `agent asks: ${trim(text)}` : null;
    }
    case "session.started": {
      const text = stringFrom(p, ["prompt", "task"]);
      return text ? `task: ${trim(text)}` : null;
    }
    default:
      return null;
  }
}

function stringFrom(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function trim(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > 400
    ? `${collapsed.slice(0, 400)}…`
    : collapsed;
}
