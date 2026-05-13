/**
 * X1A-103 — track the in-flight wake's event_id and stamp it onto the
 * agent's first response emission. Pure state machine, no I/O — the
 * pod runtime calls `armWake()` when /inject hits and `maybeStamp()`
 * on each emitted event. The frontend uses the stamped id to clear
 * the matching `session.agent_thinking` indicator.
 *
 * Behaviour contract:
 *   - At most one event_id is "armed" at a time. A second wake
 *     supersedes the first — the older indicator will time out via
 *     X1A-104's client-side TTL fallback, OR by an explicit cancel
 *     emission from the pod when it shuts down.
 *   - Only the FIRST stampable emission consumes the armed id; later
 *     emissions in the same turn don't carry it (one wake → one
 *     correlation event is enough for the frontend).
 *   - Stampable = agent.* emissions and session.completed/.failed.
 *     Skip transient indicator events (they carry event_id natively)
 *     and user.* echoes (those are inputs, not the agent's reply).
 */

const TRANSIENT_TYPES = new Set([
  "session.agent_thinking",
  "session.agent_thinking_cancelled",
]);

export function isStampable(type: string): boolean {
  if (TRANSIENT_TYPES.has(type)) return false;
  return (
    type.startsWith("agent.") ||
    type === "session.completed" ||
    type === "session.failed"
  );
}

export interface EventCorrelator {
  /** Arm a fresh event_id (called when /inject receives a wake). */
  arm(eventId: string): void;
  /** Drop the armed id without stamping (called on cancel / shutdown). */
  clear(): void;
  /**
   * If the event is stampable AND an event_id is armed, mutate the
   * payload to include `event_id` and consume the armed id. Returns
   * true iff the payload was stamped.
   */
  maybeStamp(event: { type: string; payload: unknown }): boolean;
  /** The currently-armed event_id (or null). For shutdown safety logic. */
  pending(): string | null;
}

export function createEventCorrelator(): EventCorrelator {
  let pending: string | null = null;
  return {
    arm(eventId: string) {
      pending = eventId;
    },
    clear() {
      pending = null;
    },
    pending() {
      return pending;
    },
    maybeStamp(event) {
      if (!pending) return false;
      if (!isStampable(event.type)) return false;
      if (
        !event.payload ||
        typeof event.payload !== "object" ||
        Array.isArray(event.payload)
      ) {
        return false;
      }
      (event.payload as Record<string, unknown>).event_id = pending;
      pending = null;
      return true;
    },
  };
}
