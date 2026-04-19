import type { UserId } from "@x1agent/kernel";
import type { AgentId, AgentRepository } from "@x1agent/domain-agents";
import { AgentNotFoundError } from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import type { AdminGuard } from "../ports/admin-guard.js";
import type { Session } from "../domain/session.js";

export interface ListSessionsDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  adminGuard: AdminGuard;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listSessions(
  deps: ListSessionsDeps,
  actor: UserId,
  agentId: AgentId,
  limit: number = DEFAULT_LIMIT,
): Promise<readonly Session[]> {
  const agent = await deps.agents.findById(agentId);
  if (!agent) throw new AgentNotFoundError(agentId);
  await deps.adminGuard.assertAdmin(actor, agent.workspaceId);
  const clamped = Math.max(1, Math.min(MAX_LIMIT, limit | 0));
  return deps.sessions.listByAgent(agentId, clamped);
}
