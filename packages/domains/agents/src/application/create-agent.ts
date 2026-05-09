import type {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import type { AgentRepository } from "../ports/agent-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { WorkspaceMemberReader } from "../ports/workspace-member-reader.js";
import type { Agent } from "../domain/agent.js";
import type { RuntimeType } from "../domain/runtime.js";
import type { AgentKind } from "../domain/kind.js";
import type { CronSchedule } from "../domain/cron-schedule.js";
import {
  AgentSlugTakenError,
  ScheduledRunAsUserNotInWorkspaceError,
} from "../domain/agent.js";

export interface CreateAgentDeps {
  agents: AgentRepository;
  adminGuard: AdminGuard;
  /**
   * Optional — wired in the composition root so the agents domain
   * doesn't reach across to workspaces directly. When omitted the
   * scheduledRunAsUserId is accepted without validation (used by
   * unit tests that don't care about cross-tenant scope).
   */
  members?: WorkspaceMemberReader;
}

export interface CreateAgentInput {
  actor: UserId;
  workspaceId: WorkspaceId;
  slug: WorkspaceSlug;
  name: string;
  runtimeType: RuntimeType;
  kind?: AgentKind;
  systemPrompt?: string;
  heartbeatMd?: string;
  schedule?: CronSchedule | null;
  imageId?: string | null;
  /** Per-agent override for the SDK model. Null = deployment default. */
  model?: string | null;
  /**
   * User the scheduler should impersonate when this agent's cron
   * fires. Defaults to the creator (= input.actor) when omitted.
   * Validated to be a workspace member when `members` dep is wired.
   */
  scheduledRunAsUserId?: UserId | null;
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

  // Default scheduled-run-as user = creator. Explicit null clears it.
  const runAs =
    input.scheduledRunAsUserId === undefined
      ? input.actor
      : input.scheduledRunAsUserId;

  // Cross-tenant guard: a non-null run-as user must be a member of
  // this workspace. Without this check, an admin in workspace A could
  // set the field to a user from workspace B and the scheduler would
  // mint OAuth tokens as that B-user — a tenant-isolation hole.
  if (runAs !== null && deps.members) {
    const ok = await deps.members.isMember(input.workspaceId, runAs);
    if (!ok) throw new ScheduledRunAsUserNotInWorkspaceError(runAs);
  }

  return deps.agents.create({
    workspaceId: input.workspaceId,
    slug: input.slug,
    name: input.name,
    runtimeType: input.runtimeType,
    kind: input.kind ?? "worker",
    systemPrompt: input.systemPrompt ?? "",
    heartbeatMd: input.heartbeatMd ?? "",
    schedule: input.schedule ?? null,
    imageId: input.imageId ?? null,
    model: input.model ?? null,
    scheduledRunAsUserId: runAs,
    createdBy: input.actor,
  });
}
