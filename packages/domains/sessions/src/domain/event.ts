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
