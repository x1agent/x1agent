import type { UserId } from "@x1agent/kernel";
import type {
  AgentRepository,
  UpdateAgentInput,
} from "../ports/agent-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { WorkspaceMemberReader } from "../ports/workspace-member-reader.js";
import {
  AgentNotFoundError,
  ScheduledRunAsUserNotInWorkspaceError,
  type Agent,
  type AgentId,
} from "../domain/agent.js";

export interface UpdateAgentDeps {
  agents: AgentRepository;
  adminGuard: AdminGuard;
  /** Wired in the composition root; optional in tests. */
  members?: WorkspaceMemberReader;
}

export async function updateAgent(
  deps: UpdateAgentDeps,
  actor: UserId,
  agentId: AgentId,
  patch: UpdateAgentInput,
): Promise<Agent> {
  const current = await deps.agents.findById(agentId);
  if (!current) throw new AgentNotFoundError(agentId);

  await deps.adminGuard.assertAdmin(actor, current.workspaceId);

  // Same cross-tenant guard as createAgent — when the patch includes
  // a non-null scheduled-run-as user, validate they belong to the
  // agent's workspace before persisting. An admin in workspace A
  // could otherwise set the field to a user from workspace B and the
  // scheduler would mint OAuth tokens as that B-user.
  if (
    patch.scheduledRunAsUserId !== undefined &&
    patch.scheduledRunAsUserId !== null &&
    deps.members
  ) {
    const ok = await deps.members.isMember(
      current.workspaceId,
      patch.scheduledRunAsUserId,
    );
    if (!ok)
      throw new ScheduledRunAsUserNotInWorkspaceError(
        patch.scheduledRunAsUserId,
      );
  }

  return deps.agents.update(agentId, patch);
}
