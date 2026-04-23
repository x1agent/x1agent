import type {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { Agent, AgentId } from "../domain/agent.js";
import type { RuntimeType } from "../domain/runtime.js";
import type { AgentKind } from "../domain/kind.js";
import type { CronSchedule } from "../domain/cron-schedule.js";

export interface CreateAgentInput {
  workspaceId: WorkspaceId;
  slug: WorkspaceSlug;
  name: string;
  runtimeType: RuntimeType;
  /** Defaults to 'worker' at the repository layer if omitted. */
  kind?: AgentKind;
  systemPrompt: string;
  heartbeatMd: string;
  schedule: CronSchedule | null;
  imageId?: string | null;
  createdBy: UserId | null;
}

export interface UpdateAgentInput {
  name?: string;
  runtimeType?: RuntimeType;
  kind?: AgentKind;
  systemPrompt?: string;
  heartbeatMd?: string;
  schedule?: CronSchedule | null;
  isActive?: boolean;
  imageId?: string | null;
}

export interface AgentRepository {
  create(input: CreateAgentInput): Promise<Agent>;

  findById(id: AgentId): Promise<Agent | null>;

  findBySlug(
    workspaceId: WorkspaceId,
    slug: WorkspaceSlug,
  ): Promise<Agent | null>;

  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly Agent[]>;

  update(id: AgentId, patch: UpdateAgentInput): Promise<Agent>;

  delete(id: AgentId): Promise<void>;

  /**
   * Agents whose `schedule` is set and `is_active = true`. Used by the
   * scheduler (when it lands) to walk candidates.
   */
  listScheduled(): Promise<readonly Agent[]>;

  /**
   * Bump `agents.last_scheduler_tick_at` on a successful scheduler
   * tick (create or inject). The scheduler uses this as the anchor
   * for computing the next-due time, independent of whether a
   * session was created.
   */
  recordSchedulerTick(id: AgentId, at: Date): Promise<void>;
}
