import type postgres from "postgres";
import { UserId, WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import type {
  AgentRepository,
  CreateAgentInput,
  UpdateAgentInput,
} from "../../ports/agent-repository.js";
import { AgentId, type Agent } from "../../domain/agent.js";
import { RuntimeType } from "../../domain/runtime.js";
import { AgentKind } from "../../domain/kind.js";
import { CronSchedule } from "../../domain/cron-schedule.js";
import type { AgentSkillSource } from "../../domain/skill-source.js";

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
  model: string | null;
  owner_user_id: string | null;
  visibility: string;
  created_by: string | null;
  scheduled_run_as_user_id: string | null;
  idle_timeout_seconds: number | null;
  skill_sources: AgentSkillSource[];
  created_at: Date | string;
  updated_at: Date | string;
  last_scheduler_tick_at: Date | string | null;
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
    model: r.model,
    ownerUserId: r.owner_user_id ? UserId(r.owner_user_id) : null,
    visibility:
      (r.visibility as "private" | "workspace" | "via_grants") ?? "workspace",
    createdBy: r.created_by ? UserId(r.created_by) : null,
    scheduledRunAsUserId: r.scheduled_run_as_user_id
      ? UserId(r.scheduled_run_as_user_id)
      : null,
    idleTimeoutSeconds: r.idle_timeout_seconds,
    skillSources: r.skill_sources ?? [],
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    lastSchedulerTickAt: r.last_scheduler_tick_at
      ? new Date(r.last_scheduler_tick_at)
      : null,
  };
}

const SELECT = `
  id, workspace_id, slug, name, runtime_type, kind, system_prompt,
  heartbeat_md, schedule, is_active, image_id, model,
  owner_user_id, visibility, created_by, scheduled_run_as_user_id,
  idle_timeout_seconds, skill_sources,
  created_at, updated_at, last_scheduler_tick_at
`;

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateAgentInput): Promise<Agent> {
    // Default scheduledRunAsUserId to the creator. Same default the
    // migration backfilled for existing rows. Caller can pass null to
    // explicitly opt out (rare — only useful when an agent has neither
    // a schedule nor remote_oauth MCPs).
    const runAs =
      input.scheduledRunAsUserId === undefined
        ? input.createdBy
        : input.scheduledRunAsUserId;
    const rows = await this.sql<Row[]>`
      INSERT INTO agents
        (workspace_id, slug, name, runtime_type, kind, system_prompt,
         heartbeat_md, schedule, image_id, model,
         owner_user_id, visibility, created_by, scheduled_run_as_user_id,
         idle_timeout_seconds, skill_sources)
      VALUES
        (${input.workspaceId}, ${input.slug}, ${input.name},
         ${input.runtimeType}, ${input.kind ?? "worker"},
         ${input.systemPrompt}, ${input.heartbeatMd}, ${input.schedule},
         ${input.imageId ?? null}, ${input.model ?? null},
         ${input.createdBy /* default ownership = creator */},
         ${input.visibility ?? "workspace"},
         ${input.createdBy},
         ${runAs},
         ${input.idleTimeoutSeconds ?? null},
         ${this.sql.json((input.skillSources ?? []) as never)})
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

  async listByWorkspace(workspaceId: WorkspaceId): Promise<readonly Agent[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(SELECT)} FROM agents
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
    return rows.map(toAgent);
  }

  async update(id: AgentId, patch: UpdateAgentInput): Promise<Agent> {
    // When the schedule field is part of this patch (set to a value or
    // explicitly cleared), reset last_scheduler_tick_at to now(). This
    // anchors the next nextDue computation off "now" instead of the
    // agent's createdAt, which prevents the scheduler from emitting a
    // backfill of phantom sessions for every missed slot since the
    // agent was created. No backfill is the documented policy — see
    // schedule-due-sessions.ts. When `schedule` is not in the patch,
    // last_scheduler_tick_at is left untouched so live scheduling
    // continues uninterrupted.
    const scheduleIncluded = patch.schedule !== undefined;
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
        model         = ${patch.model === undefined ? this.sql`model` : patch.model},
        owner_user_id = ${patch.ownerUserId === undefined ? this.sql`owner_user_id` : patch.ownerUserId},
        visibility    = COALESCE(${patch.visibility ?? null}, visibility),
        scheduled_run_as_user_id = ${patch.scheduledRunAsUserId === undefined ? this.sql`scheduled_run_as_user_id` : patch.scheduledRunAsUserId},
        idle_timeout_seconds = ${patch.idleTimeoutSeconds === undefined ? this.sql`idle_timeout_seconds` : patch.idleTimeoutSeconds},
        skill_sources = ${patch.skillSources === undefined ? this.sql`skill_sources` : this.sql.json(patch.skillSources as never)},
        last_scheduler_tick_at = ${scheduleIncluded ? this.sql`now()` : this.sql`last_scheduler_tick_at`},
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

  async recordSchedulerTick(id: AgentId, at: Date): Promise<void> {
    await this.sql`
      UPDATE agents SET last_scheduler_tick_at = ${at} WHERE id = ${id}
    `;
  }
}
