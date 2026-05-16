import type postgres from "postgres";
import type {
  AppendSessionEventInput,
  SessionEventRepository,
} from "../../ports/session-event-repository.js";
import {
  SessionEventDuplicateError,
  SessionEventId,
  type SessionEvent,
} from "../../domain/event.js";
import { SessionId } from "../../domain/session.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  session_id: string;
  seq: string | number;
  type: string;
  payload: unknown;
  timestamp: Date | string;
  created_at: Date | string;
}

function toEvent(r: Row): SessionEvent {
  return {
    id: SessionEventId(r.id),
    sessionId: SessionId(r.session_id),
    seq: Number(r.seq),
    type: r.type,
    payload: r.payload,
    timestamp: new Date(r.timestamp),
    createdAt: new Date(r.created_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

const SELECT = `id, session_id, seq, type, payload, timestamp, created_at`;

export class PostgresSessionEventRepository implements SessionEventRepository {
  constructor(private readonly sql: Sql) {}

  async append(input: AppendSessionEventInput): Promise<SessionEvent> {
    try {
      const rows = await this.sql<Row[]>`
        INSERT INTO session_events
          (session_id, seq, type, payload, timestamp)
        VALUES
          (${input.sessionId}, ${input.seq}, ${input.type},
           ${this.sql.json(input.payload as never)}, ${input.timestamp})
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      return toEvent(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new SessionEventDuplicateError(input.sessionId, input.seq);
      }
      throw err;
    }
  }

  async listBySession(
    sessionId: SessionId,
    opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {},
  ): Promise<readonly SessionEvent[]> {
    const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));
    const after = opts.afterSeq ?? -1;
    if (opts.beforeSeq !== undefined) {
      // "Last N events before X" → DESC + LIMIT, then re-sort ASC so
      // the caller always sees oldest-first.
      const rows = await this.sql<Row[]>`
        SELECT ${this.sql.unsafe(SELECT)} FROM session_events
        WHERE session_id = ${sessionId}
          AND seq > ${after}
          AND seq < ${opts.beforeSeq}
        ORDER BY seq DESC
        LIMIT ${limit}
      `;
      return rows.map(toEvent).reverse();
    }
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM session_events
      WHERE session_id = ${sessionId} AND seq > ${after}
      ORDER BY seq ASC
      LIMIT ${limit}
    `;
    return rows.map(toEvent);
  }
}
