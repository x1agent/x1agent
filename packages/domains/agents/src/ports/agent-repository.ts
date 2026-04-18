import type {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { Agent, AgentId } from "../domain/agent.js";
import type { RuntimeType } from "../domain/runtime.js";
import type { CronSchedule } from "../domain/cron-schedule.js";

export interface CreateAgentInput {
  workspaceId: WorkspaceId;
  slug: WorkspaceSlug;
  name: string;
  runtimeType: RuntimeType;
  systemPrompt: string;
  heartbeatMd: string;
  schedule: CronSchedule | null;
  createdBy: UserId | null;
}

export interface UpdateAgentInput {
  name?: string;
  runtimeType?: RuntimeType;
  systemPrompt?: string;
  heartbeatMd?: string;
  schedule?: CronSchedule | null;
  isActive?: boolean;
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
}
