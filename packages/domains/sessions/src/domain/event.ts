import { DomainError } from "@x1agent/kernel";
import type { SessionId } from "./session.js";

declare const sessionEventIdBrand: unique symbol;
export type SessionEventId = string & {
  readonly [sessionEventIdBrand]: true;
};
export const SessionEventId = (raw: string): SessionEventId =>
  raw as SessionEventId;

/**
 * A single wire event on a session. `seq` is the sidecar's
 * monotonically-increasing sequence number within the session; `type`
 * is one of the values listed in docs/architecture/sessions.md.
 */
export interface SessionEvent {
  id: SessionEventId;
  sessionId: SessionId;
  seq: number;
  type: string;
  payload: unknown;
  timestamp: Date;
  createdAt: Date;
}

export class SessionEventDuplicateError extends DomainError {
  readonly code = "session_event_duplicate";
  constructor(
    public readonly sessionId: string,
    public readonly seq: number,
  ) {
    super(`event seq ${seq} already recorded for session ${sessionId}`);
  }
}

/**
 * X1A-110 — share-comment wakes are persisted as `user.message` events
 * (the wake travels through the agent's SSE round-trip, which only
 * forwards `text`), but they belong in the share's comment flyout, not
 * the session's main timeline. Centralising the predicate so the
 * server-side filter (`listSessionEvents`) and the client-side
 * compactor stay in lockstep — if one drifts the other becomes a leak.
 *
 * The api subscriber re-derives `kind` from the wake-text prefix
 * (`deriveWakeKindFromText` in packages/api/src/nats/subscriber.ts);
 * by the time a row lands in `session_events` the payload carries
 * `kind: "comment_added" | "comment_resolved"` and we can match on it
 * without re-parsing the text.
 */
export function isShareCommentWakeEvent(ev: {
  type: string;
  payload: unknown;
}): boolean {
  if (ev.type !== "user.message") return false;
  if (typeof ev.payload !== "object" || ev.payload === null) return false;
  const kind = (ev.payload as { kind?: unknown }).kind;
  return kind === "comment_added" || kind === "comment_resolved";
}
