import type {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { AgentRepository } from "../ports/agent-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { Agent } from "../domain/agent.js";
import type { RuntimeType } from "../domain/runtime.js";
import type { CronSchedule } from "../domain/cron-schedule.js";
import { AgentSlugTakenError } from "../domain/agent.js";

export interface CreateAgentDeps {
  agents: AgentRepository;
  adminGuard: AdminGuard;
}

export interface CreateAgentInput {
  actor: UserId;
  workspaceId: WorkspaceId;
  slug: WorkspaceSlug;
  name: string;
  runtimeType: RuntimeType;
  systemPrompt?: string;
  heartbeatMd?: string;
  schedule?: CronSchedule | null;
  imageId?: string | null;
}

export async function createAgent(
  deps: CreateAgentDeps,
  input: CreateAgentInput,
): Promise<Agent> {
  await deps.adminGuard.assertAdmin(input.actor, input.workspaceId);

  const existing = await deps.agents.findBySlug(
    input.workspaceId,
    input.slug,
  );
  if (existing) throw new AgentSlugTakenError(input.slug);

  return deps.agents.create({
    workspaceId: input.workspaceId,
    slug: input.slug,
    name: input.name,
    runtimeType: input.runtimeType,
    systemPrompt: input.systemPrompt ?? "",
    heartbeatMd: input.heartbeatMd ?? "",
    schedule: input.schedule ?? null,
    imageId: input.imageId ?? null,
    createdBy: input.actor,
  });
}
