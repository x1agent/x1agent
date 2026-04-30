import type postgres from "postgres";
import { UserId, makeSubject, type Subject } from "@x1agent/kernel";
import type {
  AgentGrantRepository,
  CreateAgentGrantInput,
} from "../../ports/agent-grant-repository.js";
import {
  AgentGrant,
  AgentGrantId,
  type AgentVerb,
} from "../../domain/grant.js";
import { AgentId } from "../../domain/agent.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  agent_id: string;
  subject_kind: string;
  subject_id: string | null;
  verb: string;
  granted_by: string;
  created_at: Date | string;
}

function toGrant(r: Row): AgentGrant {
  return {
    id: AgentGrantId(r.id),
    agentId: AgentId(r.agent_id),
    subject: makeSubject(r.subject_kind, r.subject_id),
    verb: r.verb as AgentVerb,
    grantedBy: UserId(r.granted_by),
    createdAt: new Date(r.created_at),
  };
}

const SELECT = `id, agent_id, subject_kind, subject_id, verb, granted_by, created_at`;

export class PostgresAgentGrantRepository implements AgentGrantRepository {
  constructor(private readonly sql: Sql) {}

  async upsert(input: CreateAgentGrantInput): Promise<AgentGrant> {
    const subjectId = input.subject.kind === "user" || input.subject.kind === "group"
      ? input.subject.id
      : null;
    // Two ON CONFLICT targets — for subject-id-bearing rows vs the
    // global subjects (workspace / public). Distinguish via the
    // null-ness of subject_id.
    if (subjectId !== null) {
      const rows = await this.sql<Row[]>`
        INSERT INTO agent_grants
          (agent_id, subject_kind, subject_id, verb, granted_by)
        VALUES
          (${input.agentId}, ${input.subject.kind}, ${subjectId},
           ${input.verb}, ${input.grantedBy})
        ON CONFLICT (agent_id, subject_kind, subject_id, verb)
          WHERE subject_id IS NOT NULL
          DO UPDATE SET granted_by = EXCLUDED.granted_by,
                        created_at = now()
        RETURNING ${this.sql.unsafe(SELECT)}
      `;
      return toGrant(rows[0]!);
    }
    const rows = await this.sql<Row[]>`
      INSERT INTO agent_grants
        (agent_id, subject_kind, subject_id, verb, granted_by)
      VALUES
        (${input.agentId}, ${input.subject.kind}, NULL,
         ${input.verb}, ${input.grantedBy})
      ON CONFLICT (agent_id, subject_kind, verb)
        WHERE subject_id IS NULL
        DO UPDATE SET granted_by = EXCLUDED.granted_by,
                      created_at = now()
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toGrant(rows[0]!);
  }

  async remove(id: AgentGrantId): Promise<void> {
    await this.sql`DELETE FROM agent_grants WHERE id = ${id}`;
  }

  async removeForSubject(
    agentId: AgentId,
    subject: Subject,
    verb: AgentVerb,
  ): Promise<void> {
    if (subject.id !== null) {
      await this.sql`
        DELETE FROM agent_grants
        WHERE agent_id = ${agentId}
          AND subject_kind = ${subject.kind}
          AND subject_id = ${subject.id}
          AND verb = ${verb}
      `;
    } else {
      await this.sql`
        DELETE FROM agent_grants
        WHERE agent_id = ${agentId}
          AND subject_kind = ${subject.kind}
          AND subject_id IS NULL
          AND verb = ${verb}
      `;
    }
  }

  async listForAgent(agentId: AgentId): Promise<readonly AgentGrant[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM agent_grants
      WHERE agent_id = ${agentId}
      ORDER BY created_at DESC
    `;
    return rows.map(toGrant);
  }

  async listVerbsForResolver(input: {
    agentId: AgentId;
    userId: UserId;
    userGroupIds: readonly string[];
    userIsWorkspaceMember: boolean;
  }): Promise<ReadonlySet<AgentVerb>> {
    // Build a single SELECT that walks every subject_kind path the
    // user qualifies for. UNION DISTINCT collapses duplicates so the
    // returned set has each verb at most once.
    const groupIds =
      input.userGroupIds.length > 0
        ? (input.userGroupIds as unknown as string[])
        : null;

    const rows = await this.sql<{ verb: string }[]>`
      SELECT DISTINCT verb FROM agent_grants
      WHERE agent_id = ${input.agentId}
        AND (
          (subject_kind = 'user'  AND subject_id = ${input.userId})
          OR (subject_kind = 'group'  AND ${groupIds === null ? false : true} AND subject_id = ANY(${groupIds ?? []}::uuid[]))
          OR (subject_kind = 'workspace' AND ${input.userIsWorkspaceMember})
          OR (subject_kind = 'public')
        )
    `;
    const set = new Set<AgentVerb>();
    for (const r of rows) {
      if (r.verb === "view" || r.verb === "invoke" || r.verb === "edit") {
        set.add(r.verb);
      }
    }
    return set;
  }
}
