/**
 * X1A-103 — derive the `session.agent_thinking` payload from an
 * /inject body.
 *
 * Wake classification rules (locked by X1A-103):
 *
 *   wake_source     | trigger envelope                              | event_id
 *   ----------------|-----------------------------------------------|----------
 *   user            | browser-published user.message                | client UUID
 *   share_comment   | api-published kind=comment_added/_resolved    | comment_id
 *   child_message   | sidecar-published kind=message (child→parent) | wake event id
 *   scheduler       | api-published kind=heartbeat                  | scheduler tick
 *   platform        | api-published kind=state_change/watchdog/checkup
 *
 * The agent doesn't trust upstream classification on its own — when the
 * envelope explicitly carries `wake_source`, that wins. Otherwise we
 * derive it from `kind` + `source`. When both are absent we default to
 * `user`, which is what a raw browser publish looks like.
 *
 * `event_id` is required in the spec but might be absent on legacy
 * publishers. We mint a UUID when missing so downstream correlation
 * still works (the frontend just uses whatever event_id it sees).
 *
 * `share_id`/`thread_id` are forwarded as-is from the envelope (only
 * present on share_comment wakes).
 */
import { randomUUID } from "node:crypto";

export type WakeSource =
  | "user"
  | "share_comment"
  | "child_message"
  | "scheduler"
  | "platform";

export interface WakeEnvelopeFields {
  /** Wake-triggering event id (browser-stamped UUID, comment_id, etc). */
  event_id?: string | null;
  /** Pre-classified source. When set, wins over kind/source derivation. */
  wake_source?: string | null;
  /** Set on share_comment wakes only. */
  share_id?: string | null;
  /** Set on share_comment wakes only. */
  thread_id?: string | null;
  /** Wake-publisher kind: comment_added, heartbeat, state_change, etc. */
  kind?: string | null;
  /** Wake-publisher source: "platform" for server-driven, absent for user. */
  source?: string | null;
  /**
   * Set on agent-injected user-input replies (request_input). Treat the
   * answer as part of the same conversational turn — it's still a user
   * wake, but the indicator should clear on the agent's next emission
   * just like a regular message.
   */
  request_id?: string | null;
}

const VALID_SOURCES: ReadonlySet<WakeSource> = new Set([
  "user",
  "share_comment",
  "child_message",
  "scheduler",
  "platform",
]);

/**
 * Map (kind, source) → wake_source. The mapping mirrors the publishers
 * in packages/api/src/orchestration/wake-publisher.ts and the
 * orchestrator's `inject_message` MCP tool routed through the sidecar.
 */
export function classifyWakeSource(fields: WakeEnvelopeFields): WakeSource {
  if (fields.wake_source && VALID_SOURCES.has(fields.wake_source as WakeSource)) {
    return fields.wake_source as WakeSource;
  }
  const kind = fields.kind ?? "";
  if (kind === "comment_added" || kind === "comment_resolved") {
    return "share_comment";
  }
  if (kind === "heartbeat") {
    return "scheduler";
  }
  if (
    kind === "state_change" ||
    kind === "watchdog" ||
    kind === "checkup"
  ) {
    return "platform";
  }
  if (kind === "message") {
    // child→parent message_caller wake.
    return "child_message";
  }
  return "user";
}

export interface AgentThinkingPayload {
  type: "session.agent_thinking";
  session_id: string;
  share_id: string | null;
  thread_id: string | null;
  event_id: string;
  wake_source: WakeSource;
  started_at: string;
}

export function buildAgentThinkingEvent(
  sessionId: string,
  fields: WakeEnvelopeFields,
  now: Date = new Date(),
): AgentThinkingPayload {
  const wake_source = classifyWakeSource(fields);
  // Share scope: only forward share_id/thread_id when both are present
  // AND the wake actually came from a share_comment. Per spec contract:
  // "either both are set, or both are null."
  const isShareComment = wake_source === "share_comment";
  const share_id =
    isShareComment && fields.share_id && fields.thread_id
      ? fields.share_id
      : null;
  const thread_id =
    isShareComment && fields.share_id && fields.thread_id
      ? fields.thread_id
      : null;

  // event_id contract: prefer the upstream-stamped id (browser UUID,
  // comment_id, scheduler tick id). Mint locally only when the
  // publisher didn't stamp one — keeps best-effort correlation when an
  // older publisher hits a newer agent.
  const event_id = fields.event_id ? fields.event_id : randomUUID();

  return {
    type: "session.agent_thinking",
    session_id: sessionId,
    share_id,
    thread_id,
    event_id,
    wake_source,
    started_at: now.toISOString(),
  };
}

export interface AgentThinkingCancelledPayload {
  type: "session.agent_thinking_cancelled";
  session_id: string;
  event_id: string;
  /** Free-text reason for the cancel. The frontend ignores it; useful in logs. */
  reason: "graceful_shutdown" | "idle_timeout" | "end_session";
}

export function buildAgentThinkingCancelledEvent(
  sessionId: string,
  eventId: string,
  reason: AgentThinkingCancelledPayload["reason"],
): AgentThinkingCancelledPayload {
  return {
    type: "session.agent_thinking_cancelled",
    session_id: sessionId,
    event_id: eventId,
    reason,
  };
}

/**
 * The two transient event types emitted by this module. Re-exported so
 * the api subscriber's persistence skip-list and any frontend
 * type-guards stay in lockstep.
 */
export const TRANSIENT_EVENT_TYPES = new Set<string>([
  "session.agent_thinking",
  "session.agent_thinking_cancelled",
]);
