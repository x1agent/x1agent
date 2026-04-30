import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import type {
  CreateSessionShareInput,
  SessionShareRepository,
} from "../../ports/session-share-repository.js";
import {
  SessionShare,
  SessionShareId,
  ShareRole,
} from "../../domain/share.js";
import { SessionId } from "../../domain/session.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  shared_by: string;
  created_at: Date | string;
}

function toShare(r: Row): SessionShare {
  return {
    id: SessionShareId(r.id),
    sessionId: SessionId(r.session_id),
    userId: UserId(r.user_id),
    role: r.role as ShareRole,
    sharedBy: UserId(r.shared_by),
    createdAt: new Date(r.created_at),
  };
}

const SELECT = `id, session_id, user_id, role, shared_by, created_at`;

export class PostgresSessionShareRepository implements SessionShareRepository {
  constructor(private readonly sql: Sql) {}

  async upsert(input: CreateSessionShareInput): Promise<SessionShare> {
    const rows = await this.sql<Row[]>`
      INSERT INTO session_user_shares
        (session_id, user_id, role, shared_by)
      VALUES
        (${input.sessionId}, ${input.userId}, ${input.role}, ${input.sharedBy})
      ON CONFLICT (session_id, user_id) DO UPDATE
        SET role      = EXCLUDED.role,
            shared_by = EXCLUDED.shared_by
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toShare(rows[0]!);
  }

  async remove(id: SessionShareId): Promise<void> {
    await this.sql`DELETE FROM session_user_shares WHERE id = ${id}`;
  }

  async removeForUser(
    sessionId: SessionId,
    userId: UserId,
  ): Promise<void> {
    await this.sql`
      DELETE FROM session_user_shares
      WHERE session_id = ${sessionId} AND user_id = ${userId}
    `;
  }

  async listForSession(
    sessionId: SessionId,
  ): Promise<readonly SessionShare[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM session_user_shares
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
    `;
    return rows.map(toShare);
  }

  async listForUser(userId: UserId): Promise<readonly SessionShare[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM session_user_shares
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return rows.map(toShare);
  }

  async findForUser(
    sessionId: SessionId,
    userId: UserId,
  ): Promise<SessionShare | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM session_user_shares
      WHERE session_id = ${sessionId} AND user_id = ${userId}
    `;
    return rows[0] ? toShare(rows[0]) : null;
  }
}
