import type postgres from "postgres";
import { UserId } from "@x1agent/kernel";
import {
  ShareCommentId,
  ShareThreadId,
  type CommentScope,
  type PassageAnchor,
  type ShareComment,
} from "../../domain/share-comment.js";
import { SessionId } from "../../domain/session.js";
import type {
  AppendShareCommentInput,
  ShareCommentRepository,
  ThreadLocator,
} from "../../ports/share-comment-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  share_id: string;
  thread_id: string;
  seq: number;
  session_id: string;
  workspace_id: string;
  share_type: string;
  comment_scope: string;
  anchor_json: PassageAnchor | null;
  body: string;
  author_user_id: string | null;
  author_session_id: string | null;
  resolved_at: Date | string | null;
  resolved_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SELECT = `
  id, share_id, thread_id, seq, session_id, workspace_id,
  share_type, comment_scope, anchor_json, body,
  author_user_id, author_session_id,
  resolved_at, resolved_by_user_id, created_at, updated_at
`;

function toComment(r: Row): ShareComment {
  return {
    id: ShareCommentId(r.id),
    shareId: r.share_id,
    threadId: ShareThreadId(r.thread_id),
    seq: r.seq,
    sessionId: SessionId(r.session_id),
    workspaceId: r.workspace_id,
    shareType: r.share_type,
    commentScope: r.comment_scope as CommentScope,
    anchorJson: r.anchor_json,
    body: r.body,
    authorUserId: r.author_user_id ? UserId(r.author_user_id) : null,
    authorSessionId: r.author_session_id
      ? SessionId(r.author_session_id)
      : null,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    resolvedByUserId: r.resolved_by_user_id
      ? UserId(r.resolved_by_user_id)
      : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

/**
 * Postgres-backed implementation of `ShareCommentRepository`.
 *
 * `append` picks `seq` with `coalesce(max(seq), 0) + 1` inside a
 * single statement using a subselect; if a concurrent insert wins the
 * unique-index race on (share_id, thread_id, seq) we retry up to
 * 5 times before bubbling. The same pattern is used by the
 * session_events repository for its (session_id, seq) constraint.
 */
const APPEND_MAX_RETRIES = 5;
const PG_UNIQUE_VIOLATION = "23505";

export class PostgresShareCommentRepository implements ShareCommentRepository {
  constructor(private readonly sql: Sql) {}

  async append(input: AppendShareCommentInput): Promise<ShareComment> {
    let attempt = 0;
    // We pre-compute the candidate seq, then INSERT optimistically.
    // The unique index serialises concurrent appends — the loser sees
    // PG_UNIQUE_VIOLATION and retries with a fresh max(seq) read.
    while (true) {
      const rows = await this.sql<{ next_seq: number }[]>`
        SELECT coalesce(max(seq), 0) + 1 AS next_seq
        FROM share_comments
        WHERE share_id = ${input.shareId} AND thread_id = ${input.threadId}
      `;
      const nextSeq = rows[0]?.next_seq ?? 1;
      try {
        const inserted = await this.sql<Row[]>`
          INSERT INTO share_comments (
            share_id, thread_id, seq, session_id, workspace_id,
            share_type, comment_scope, anchor_json, body,
            author_user_id, author_session_id
          ) VALUES (
            ${input.shareId},
            ${input.threadId},
            ${nextSeq},
            ${input.sessionId},
            ${input.workspaceId},
            ${input.shareType},
            ${input.commentScope},
            ${this.sql.json(input.anchorJson as never) ?? null},
            ${input.body},
            ${input.authorUserId},
            ${input.authorSessionId}
          )
          RETURNING ${this.sql.unsafe(SELECT)}
        `;
        return toComment(inserted[0]!);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === PG_UNIQUE_VIOLATION && attempt < APPEND_MAX_RETRIES) {
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  }

  async listByShare(
    sessionId: SessionId,
    shareId: string,
  ): Promise<readonly ShareComment[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)}
      FROM share_comments
      WHERE session_id = ${sessionId} AND share_id = ${shareId}
      ORDER BY thread_id, seq ASC
    `;
    return rows.map(toComment);
  }

  async findThread(threadId: ShareThreadId): Promise<ThreadLocator | null> {
    const rows = await this.sql<
      {
        share_id: string;
        session_id: string;
        workspace_id: string;
        share_type: string;
        resolved_at: Date | string | null;
        resolved_by_user_id: string | null;
        first_seq: number;
      }[]
    >`
      SELECT share_id, session_id, workspace_id, share_type,
             resolved_at, resolved_by_user_id,
             min(seq) AS first_seq
      FROM share_comments
      WHERE thread_id = ${threadId}
      GROUP BY share_id, session_id, workspace_id, share_type,
               resolved_at, resolved_by_user_id
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      shareId: r.share_id,
      sessionId: SessionId(r.session_id),
      workspaceId: r.workspace_id,
      shareType: r.share_type,
      resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
      resolvedByUserId: r.resolved_by_user_id
        ? UserId(r.resolved_by_user_id)
        : null,
      firstSeq: r.first_seq,
    };
  }

  async findOne(
    shareId: string,
    threadId: ShareThreadId,
    seq: number,
  ): Promise<ShareComment | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM share_comments
      WHERE share_id = ${shareId} AND thread_id = ${threadId} AND seq = ${seq}
    `;
    return rows[0] ? toComment(rows[0]) : null;
  }

  async updateBody(
    id: ShareCommentId,
    body: string,
  ): Promise<ShareComment | null> {
    const rows = await this.sql<Row[]>`
      UPDATE share_comments
      SET body = ${body}
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return rows[0] ? toComment(rows[0]) : null;
  }

  async remove(id: ShareCommentId): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM share_comments WHERE id = ${id} RETURNING id
    `;
    return rows.length > 0;
  }

  async setResolved(
    threadId: ShareThreadId,
    resolvedBy: UserId | null,
    resolvedAt: Date | null,
  ): Promise<void> {
    // Fan the resolve state across every row in the thread so
    // listByShare can answer "is this resolved" without an extra
    // aggregate. Reversing a resolve passes (null, null).
    await this.sql`
      UPDATE share_comments
      SET resolved_at = ${resolvedAt},
          resolved_by_user_id = ${resolvedBy}
      WHERE thread_id = ${threadId}
    `;
  }

  async countThreadsByShare(
    sessionId: SessionId,
    shareId: string,
  ): Promise<number> {
    const rows = await this.sql<{ n: string }[]>`
      SELECT count(DISTINCT thread_id)::text AS n
      FROM share_comments
      WHERE session_id = ${sessionId} AND share_id = ${shareId}
    `;
    return Number(rows[0]?.n ?? 0);
  }
}
