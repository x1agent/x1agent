/**
 * Event classification for the session timeline.
 *
 * The timeline has two modes:
 *   - default ("compact")   — shows only the latest *public* event,
 *                             framed by dividers. New public events
 *                             replace the previous one in place.
 *   - verbose               — renders the full event stream, including
 *                             internal/intermittent events (tool
 *                             searches, internal LLM tool calls,
 *                             session.init dumps, raw tool results).
 *
 * "Public" events are the ones an operator should see at-a-glance to
 * understand what the agent is doing or saying. Tool-call mechanics
 * are useful for debugging but they bury the signal — keep them
 * behind the verbose toggle.
 */
import type { SessionEventDTO } from "@x1agent/shared";

/**
 * Event types that are always considered public — they describe an
 * agent's state or visible output and belong in the calm default view.
 *
 * Anything not in this set is treated as internal and only renders in
 * verbose mode. The `default` branch in EventCard already collapses
 * unknown types to null in compact mode, so this list is intentionally
 * narrow rather than guessing.
 */
const PUBLIC_EVENT_TYPES = new Set<string>([
  "session.started",
  "session.completed",
  "session.failed",
  "session.resumed",
  "user.message",
  "user.input_response",
  "agent.text",
  "agent.status",
  "agent.artifact",
  "agent.share",
  "agent.input_request",
  "agent.permission_request",
  "agent.error",
]);

export function isPublicEventType(type: string): boolean {
  return PUBLIC_EVENT_TYPES.has(type);
}

/**
 * Returns the most recent public event from the stream, or `null` if
 * the stream contains no public events yet (e.g. session just spun up
 * and we've only seen `session.init` + tool searches).
 *
 * Events are assumed to be in append order (lowest seq first). We walk
 * from the tail to find the latest public entry without sorting —
 * sorting on every render would be quadratic for long sessions.
 */
export function latestPublicEvent(
  events: readonly SessionEventDTO[],
): SessionEventDTO | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && isPublicEventType(ev.type)) return ev;
  }
  return null;
}
