import type postgres from "postgres";
import { UserId, type WorkspaceId } from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import type {
  CreateSessionInput,
  SessionRepository,
  UpdateSessionStatusInput,
} from "../../ports/session-repository.js";
import {
  SessionDuplicateTickError,
  SessionId,
  SessionNotFoundError,
  type Session,
} from "../../domain/session.js";
import { SessionStatus } from "../../domain/status.js";
import { TriggerSource } from "../../domain/trigger.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  agent_id: string;
  triggered_by: string;
  triggered_by_user_id: string | null;
  parent_session_id: string | null;
  parent_agent_id: string | null;
  resumed_from: string | null;
  triggered_at: Date | string;
  status: string;
  completed_at: Date | string | null;
  error_message: string | null;
  created_at: Date | string;
  summary: string | null;
  summary_updated_at: Date | string | null;
  summary_event_seq: number | string | null;
}

function toSession(r: Row): Session {
  return {
    id: SessionId(r.id),
    agentId: AgentId(r.agent_id),
    triggeredBy: TriggerSource(r.triggered_by),
    triggeredByUserId: r.triggered_by_user_id
      ? UserId(r.triggered_by_user_id)
      : null,
    parentSessionId: r.parent_session_id
      ? SessionId(r.parent_session_id)
      : null,
    parentAgentId: r.parent_agent_id ? AgentId(r.parent_agent_id) : null,
    resumedFromSessionId: r.resumed_from ? SessionId(r.resumed_from) : null,
    triggeredAt: new Date(r.triggered_at),
    status: SessionStatus(r.status),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    errorMessage: r.error_message,
    createdAt: new Date(r.created_at),
    summary: r.summary,
    summaryUpdatedAt: r.summary_updated_at
      ? new Date(r.summary_updated_at)
      : null,
    summaryEventSeq:
      r.summary_event_seq === null || r.summary_event_seq === undefined
        ? null
        : Number(r.summary_event_seq),
  };
}

const SELECT = `
  id, agent_id, triggered_by, triggered_by_user_id,
  parent_session_id, parent_agent_id, resumed_from,
  triggered_at, status, completed_at, error_message, created_at,
  summary, summary_updated_at, summary_event_seq
`;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateSessionInput): Promise<Session> {
    try {
      const rows = await this.sql<Row[]>`
        INSERT INTO sessions
          (agent_id, triggered_by, triggered_by_user_id,
           parent_session_id, parent_agent_id, resumed_from,
           triggered_at)
        VALUES
          (${input.agentId}, ${input.triggeredBy},
           ${input.triggeredByUserId},
           ${input.parentSessionId}, ${input.parentAgentId},
           ${input.resumedFromSessionId},
           ${input.triggeredAt})
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      return toSession(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new SessionDuplicateTickError(input.agentId, input.triggeredAt);
      }
      throw err;
    }
  }

  async findById(id: SessionId): Promise<Session | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM sessions WHERE id = ${id}
    `;
    return rows[0] ? toSession(rows[0]) : null;
  }

  async listByAgent(
    agentId: AgentId,
    limit: number,
  ): Promise<readonly Session[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM sessions
      WHERE agent_id = ${agentId}
      ORDER BY triggered_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toSession);
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
    limit: number,
  ): Promise<readonly Session[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(
        SELECT
          .split(",")
          .map((c) => `sessions.${c.trim()}`)
          .join(", "),
      )}
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE agents.workspace_id = ${workspaceId}
      ORDER BY sessions.triggered_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toSession);
  }

  async listForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
    limit: number,
  ): Promise<readonly Session[]> {
    // Owned by the user OR explicitly shared. workspace_id pinned via
    // the agents join so a malformed share row can never leak across
    // workspaces.
    // The LEFT JOIN can't multiply rows because the share row is
    // pinned to ${userId} and (session_id, user_id) is unique, so no
    // DISTINCT is needed.
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(
        SELECT
          .split(",")
          .map((c) => `sessions.${c.trim()}`)
          .join(", "),
      )}
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      LEFT JOIN session_user_shares
        ON session_user_shares.session_id = sessions.id
       AND session_user_shares.user_id = ${userId}
      WHERE agents.workspace_id = ${workspaceId}
        AND (
          sessions.triggered_by_user_id = ${userId}
          OR session_user_shares.id IS NOT NULL
        )
      ORDER BY sessions.triggered_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toSession);
  }

  async listChildren(parentSessionId: SessionId): Promise<readonly Session[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM sessions
      WHERE parent_session_id = ${parentSessionId}
      ORDER BY triggered_at DESC
    `;
    return rows.map(toSession);
  }

  async lastSchedulerRunFor(agentId: AgentId): Promise<Session | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM sessions
      WHERE agent_id = ${agentId} AND triggered_by = 'scheduler'
      ORDER BY triggered_at DESC
      LIMIT 1
    `;
    return rows[0] ? toSession(rows[0]) : null;
  }

  async findLiveSessionForAgent(agentId: AgentId): Promise<Session | null> {
    // Non-terminal = pending or running. `complete` and `failed` are
    // terminal and mean the orchestrator is ready for a fresh session.
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM sessions
      WHERE agent_id = ${agentId}
        AND status IN ('pending', 'running')
      ORDER BY triggered_at DESC
      LIMIT 1
    `;
    return rows[0] ? toSession(rows[0]) : null;
  }

  async listNonTerminalOlderThan(
    threshold: Date,
  ): Promise<readonly Session[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM sessions
      WHERE status IN ('pending', 'running')
        AND triggered_at < ${threshold}
      ORDER BY triggered_at ASC
    `;
    return rows.map(toSession);
  }

  async delete(id: SessionId): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM sessions WHERE id = ${id} RETURNING id
    `;
    return rows.length > 0;
  }

  async updateStatus(
    id: SessionId,
    patch: UpdateSessionStatusInput,
  ): Promise<Session> {
    const rows = await this.sql<Row[]>`
      UPDATE sessions SET
        status        = ${patch.status},
        completed_at  = ${patch.completedAt === undefined ? this.sql`completed_at` : patch.completedAt},
        error_message = ${patch.errorMessage === undefined ? this.sql`error_message` : patch.errorMessage}
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    if (!rows[0]) throw new SessionNotFoundError(id);
    return toSession(rows[0]);
  }

  async updateSummary(
    id: SessionId,
    summary: string,
    eventSeq: number,
    updatedAt: Date,
  ): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE sessions SET
        summary            = ${summary},
        summary_event_seq  = ${eventSeq},
        summary_updated_at = ${updatedAt}
      WHERE id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }
}
