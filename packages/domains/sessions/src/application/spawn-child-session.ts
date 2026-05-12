import { DomainError, type Clock } from "@x1agent/kernel";
import {
  AgentNotFoundError,
  isOrchestratorKind,
  type Agent,
  type AgentId,
  type AgentRepository,
} from "@x1agent/domain-agents";
import type { SessionRepository } from "../ports/session-repository.js";
import { SessionId, SessionNotFoundError, type Session } from "../domain/session.js";

export class SpawnAcrossWorkspacesError extends DomainError {
  readonly code = "spawn_across_workspaces";
  constructor() {
    super("parent and child agents must share a workspace");
  }
}

export class ParentSessionTerminalError extends DomainError {
  readonly code = "parent_session_terminal";
  constructor() {
    super("parent session is not running; cannot spawn child");
  }
}

export class PermissionRequiredError extends DomainError {
  readonly code = "permission_required";
  constructor(
    public readonly parentAgentId: string,
    public readonly childAgentId: string,
  ) {
    super(
      `agent ${parentAgentId} is not allowed to spawn ${childAgentId}`,
    );
  }
}

export interface SpawnCheck {
  /**
   * Returns true if the parent agent holds an active spawn grant that
   * covers the child agent. The application layer is agnostic to the
   * grant-repo type; composition wires a findActiveGrant-backed impl.
   */
  canSpawn(parentAgentId: AgentId, childAgentId: AgentId): Promise<boolean>;
}

export interface SpawnChildSessionDeps {
  agents: AgentRepository;
  sessions: SessionRepository;
  permission: SpawnCheck;
  clock: Clock;
}

export interface SpawnChildSessionCommand {
  parentSessionId: SessionId;
  childAgentId: AgentId;
}

/**
 * An orchestrator asks to start a child session. The API's internal
 * endpoint already authenticated the sidecar token and figured out
 * which session the caller is. From here we:
 *
 *   1. Look up the parent session + its agent — reject if the parent
 *      is already terminal.
 *   2. Look up the child agent — reject if it belongs to another
 *      workspace (the Postgres check constraint would reject it too;
 *      this gives a clean error).
 *   3. Consult the permission port — reject with `permission_required`
 *      if no spawn grant covers this parent→child pair.
 *   4. Insert the child session with triggered_by='agent',
 *      parent_session_id/parent_agent_id populated.
 */
export async function spawnChildSession(
  deps: SpawnChildSessionDeps,
  cmd: SpawnChildSessionCommand,
): Promise<Session> {
  const parent = await deps.sessions.findById(cmd.parentSessionId);
  if (!parent) throw new SessionNotFoundError(cmd.parentSessionId);
  if (parent.status === "complete" || parent.status === "failed")
    throw new ParentSessionTerminalError();

  const parentAgent = await loadAgent(deps.agents, parent.agentId);
  const childAgent = await loadAgent(deps.agents, cmd.childAgentId);
  if (parentAgent.workspaceId !== childAgent.workspaceId)
    throw new SpawnAcrossWorkspacesError();

  const allowed = await deps.permission.canSpawn(
    parentAgent.id,
    childAgent.id,
  );
  if (!allowed)
    throw new PermissionRequiredError(parentAgent.id, childAgent.id);

  // Orchestrator children are singletons just like orchestrator roots —
  // if the child agent is an orchestrator and already has a live session,
  // return that session rather than creating a second one. Matches the
  // trigger-session contract; defends the 018 DB trigger from firing on
  // the expected happy-path.
  if (isOrchestratorKind(childAgent.kind)) {
    const existing = await deps.sessions.findLiveSessionForAgent(childAgent.id);
    if (existing) return existing;
  }

  // Inherit triggered_by_user_id from the parent so the child carries
  // the same user attribution as the chain root. triggered_by stays
  // "agent" because the orchestrator did the spawning — this is
  // inherited attribution, not impersonation. Without this, any child
  // whose agent has a remote_oauth (zone-3) MCP attached fails pod
  // creation in job-watcher with "remote_oauth MCPs require a
  // user-triggered session — no triggered_by_user_id set", and the
  // session surfaces as "failed, zero events" because no pod is ever
  // spawned.
  return deps.sessions.create({
    agentId: childAgent.id,
    triggeredBy: "agent",
    triggeredByUserId: parent.triggeredByUserId,
    parentSessionId: parent.id,
    parentAgentId: parent.agentId,
    resumedFromSessionId: null,
    triggeredAt: deps.clock.now(),
  });
}

async function loadAgent(
  agents: AgentRepository,
  id: AgentId,
): Promise<Agent> {
  const a = await agents.findById(id);
  if (!a) throw new AgentNotFoundError(id);
  return a;
}
