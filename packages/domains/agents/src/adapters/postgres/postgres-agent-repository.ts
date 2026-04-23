import type postgres from "postgres";
import {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type {
  AgentRepository,
  CreateAgentInput,
  UpdateAgentInput,
} from "../../ports/agent-repository.js";
import { AgentId, type Agent } from "../../domain/agent.js";
import { RuntimeType } from "../../domain/runtime.js";
import { AgentKind } from "../../domain/kind.js";
import { CronSchedule } from "../../domain/cron-schedule.js";

type Sql = postgres.Sql<Record<string, unknown>>;

interface Row {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  runtime_type: string;
  kind: string;
  system_prompt: string;
  heartbeat_md: string;
  schedule: string | null;
  is_active: boolean;
  image_id: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toAgent(r: Row): Agent {
  return {
    id: AgentId(r.id),
    workspaceId: WorkspaceId(r.workspace_id),
    slug: WorkspaceSlug(r.slug),
    name: r.name,
    runtimeType: RuntimeType(r.runtime_type),
    kind: AgentKind(r.kind),
    systemPrompt: r.system_prompt,
    heartbeatMd: r.heartbeat_md,
    schedule: r.schedule ? CronSchedule(r.schedule) : null,
    isActive: r.is_active,
    imageId: r.image_id,
    createdBy: r.created_by ? UserId(r.created_by) : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

const SELECT = `
  id, workspace_id, slug, name, runtime_type, kind, system_prompt,
  heartbeat_md, schedule, is_active, image_id, created_by,
  created_at, updated_at
`;

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateAgentInput): Promise<Agent> {
    const rows = await this.sql<Row[]>`
      INSERT INTO agents
        (workspace_id, slug, name, runtime_type, kind, system_prompt,
         heartbeat_md, schedule, image_id, created_by)
      VALUES
        (${input.workspaceId}, ${input.slug}, ${input.name},
         ${input.runtimeType}, ${input.kind ?? "worker"},
         ${input.systemPrompt}, ${input.heartbeatMd}, ${input.schedule},
         ${input.imageId ?? null}, ${input.createdBy})
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toAgent(rows[0]!);
  }

  async findById(id: AgentId): Promise<Agent | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM agents WHERE id = ${id}
    `;
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async findBySlug(
    workspaceId: WorkspaceId,
    slug: WorkspaceSlug,
  ): Promise<Agent | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM agents
      WHERE workspace_id = ${workspaceId} AND slug = ${slug}
    `;
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly Agent[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM agents
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
    return rows.map(toAgent);
  }

  async update(id: AgentId, patch: UpdateAgentInput): Promise<Agent> {
    const rows = await this.sql<Row[]>`
      UPDATE agents SET
        name          = COALESCE(${patch.name ?? null}, name),
        runtime_type  = COALESCE(${patch.runtimeType ?? null}, runtime_type),
        kind          = COALESCE(${patch.kind ?? null}, kind),
        system_prompt = COALESCE(${patch.systemPrompt ?? null}, system_prompt),
        heartbeat_md  = COALESCE(${patch.heartbeatMd ?? null}, heartbeat_md),
        schedule      = ${patch.schedule === undefined ? this.sql`schedule` : patch.schedule},
        is_active     = COALESCE(${patch.isActive ?? null}, is_active),
        image_id      = ${patch.imageId === undefined ? this.sql`image_id` : patch.imageId},
        updated_at    = now()
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(SELECT)}
    `;
    return toAgent(rows[0]!);
  }

  async delete(id: AgentId): Promise<void> {
    await this.sql`DELETE FROM agents WHERE id = ${id}`;
  }

  async listScheduled(): Promise<readonly Agent[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM agents
      WHERE schedule IS NOT NULL AND is_active = true
    `;
    return rows.map(toAgent);
  }
}
