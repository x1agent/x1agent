import type postgres from "postgres";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import { SessionId } from "@x1agent/domain-sessions";
import {
  GrantId,
  GrantScope,
  GrantType,
  type Grant,
  type GrantSubject,
} from "../../domain/grant.js";
import type {
  CreateGrantInput,
  ListActiveQuery,
  ListQuery,
  PermissionGrantRepository,
} from "../../ports/permission-grant-repository.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  user_subject_id: string | null;
  agent_subject_id: string | null;
  grant_type: string;
  details: Record<string, unknown>;
  scope: string;
  session_id: string | null;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
  granted_by_user_id: string;
  granted_at: Date | string;
  reason: string | null;
}

const SELECT = `
  id, workspace_id, user_subject_id, agent_subject_id,
  grant_type, details, scope, session_id,
  consumed_at, revoked_at,
  granted_by_user_id, granted_at, reason
`;

function toGrant(r: Row): Grant {
  const subject: GrantSubject =
    r.agent_subject_id !== null
      ? { kind: "agent", agentId: AgentId(r.agent_subject_id) }
      : { kind: "user", userId: UserId(r.user_subject_id!) };
  return {
    id: GrantId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    subject,
    grantType: GrantType(r.grant_type),
    details: r.details ?? {},
    scope: GrantScope(r.scope),
    sessionId: r.session_id ? SessionId(r.session_id) : null,
    consumedAt: r.consumed_at ? new Date(r.consumed_at) : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
    grantedByUserId: UserId(r.granted_by_user_id),
    grantedAt: new Date(r.granted_at),
    reason: r.reason,
  };
}

export class PostgresPermissionGrantRepository
  implements PermissionGrantRepository
{
  constructor(private readonly sql: Sql) {}

  async create(input: CreateGrantInput): Promise<Grant> {
    const userSubjectId =
      input.subject.kind === "user" ? input.subject.userId : null;
    const agentSubjectId =
      input.subject.kind === "agent" ? input.subject.agentId : null;

    const rows = await this.sql<Row[]>`
      INSERT INTO permission_grants
        (workspace_id, user_subject_id, agent_subject_id,
         grant_type, details, scope, session_id,
         granted_by_user_id, reason)
      VALUES
        (${input.workspaceId}, ${userSubjectId}, ${agentSubjectId},
         ${input.grantType}, ${this.sql.json(input.details as never)},
         ${input.scope}, ${input.sessionId},
         ${input.grantedByUserId}, ${input.reason})
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toGrant(rows[0]!);
  }

  async findById(id: GrantId): Promise<Grant | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM permission_grants
      WHERE id = ${id}
    `;
    return rows[0] ? toGrant(rows[0]) : null;
  }

  async list(q: ListQuery): Promise<readonly Grant[]> {
    const userSubjectId =
      q.subject?.kind === "user" ? q.subject.userId : null;
    const agentSubjectId =
      q.subject?.kind === "agent" ? q.subject.agentId : null;

    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM permission_grants
      WHERE workspace_id = ${q.workspaceId}
        ${q.subject?.kind === "user"
          ? this.sql`AND user_subject_id = ${userSubjectId}`
          : this.sql``}
        ${q.subject?.kind === "agent"
          ? this.sql`AND agent_subject_id = ${agentSubjectId}`
          : this.sql``}
        ${q.grantType
          ? this.sql`AND grant_type = ${q.grantType}`
          : this.sql``}
        ${q.includeRevoked
          ? this.sql``
          : this.sql`AND revoked_at IS NULL`}
      ORDER BY granted_at DESC
    `;
    return rows.map(toGrant);
  }

  async listActive(q: ListActiveQuery): Promise<readonly Grant[]> {
    const userSubjectId =
      q.subject.kind === "user" ? q.subject.userId : null;
    const agentSubjectId =
      q.subject.kind === "agent" ? q.subject.agentId : null;

    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM permission_grants
      WHERE workspace_id = ${q.workspaceId}
        AND grant_type = ${q.grantType}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        ${q.subject.kind === "user"
          ? this.sql`AND user_subject_id = ${userSubjectId}`
          : this.sql`AND agent_subject_id = ${agentSubjectId}`}
    `;
    return rows.map(toGrant);
  }

  async consumeIfActive(id: GrantId): Promise<Grant | null> {
    const rows = await this.sql<Row[]>`
      UPDATE permission_grants
      SET consumed_at = now()
      WHERE id = ${id}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return rows[0] ? toGrant(rows[0]) : null;
  }

  async revoke(id: GrantId): Promise<Grant | null> {
    const rows = await this.sql<Row[]>`
      UPDATE permission_grants
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return rows[0] ? toGrant(rows[0]) : null;
  }
}
