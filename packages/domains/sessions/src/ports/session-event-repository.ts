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
   * Return events for a session.
   *
   * Default ordering is oldest-first (`seq ASC`) — the common case is
   * reading the timeline from the start or paginating forward via
   * `afterSeq`.
   *
   * When `beforeSeq` is supplied the result is the LAST `limit` events
   * with `seq < beforeSeq`, returned in seq ASC order. This powers the
   * UI's "load older" pagination on the session detail page: the
   * client passes `before_seq=<first loaded seq>` and gets the
   * preceding window so it can prepend to its in-memory tail.
   *
   * If both `afterSeq` and `beforeSeq` are supplied, both predicates
   * apply (open interval, returns the slice between them).
   *
   * `limit` is clamped by the application layer.
   */
  listBySession(
    sessionId: SessionId,
    opts?: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): Promise<readonly SessionEvent[]>;
}
