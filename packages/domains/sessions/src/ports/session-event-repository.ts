import type { SessionId } from "../domain/session.js";
import type { SessionEvent } from "../domain/event.js";

export interface AppendSessionEventInput {
  sessionId: SessionId;
  seq: number;
  type: string;
  payload: unknown;
  timestamp: Date;
}

export interface SessionEventRepository {
  /**
   * Append an event. Implementations MUST translate a unique-violation
   * on (session_id, seq) into SessionEventDuplicateError so NATS
   * redelivery is idempotent for the subscriber.
   */
  append(input: AppendSessionEventInput): Promise<SessionEvent>;

  /**
   * Return events for a session, oldest-first, optionally after a
   * given sequence number. `limit` is clamped by the application layer.
   */
  listBySession(
    sessionId: SessionId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<readonly SessionEvent[]>;
}
