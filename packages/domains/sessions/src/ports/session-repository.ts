import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import type { Session, SessionId } from "../domain/session.js";
import type { SessionStatus } from "../domain/status.js";
import type { TriggerSource } from "../domain/trigger.js";

export interface CreateSessionInput {
  agentId: AgentId;
  triggeredBy: TriggerSource;
  triggeredByUserId: UserId | null;
  /** Required when triggeredBy === "agent". Null otherwise. */
  parentSessionId: SessionId | null;
  /** Required when triggeredBy === "agent". Null otherwise. */
  parentAgentId: AgentId | null;
  /**
   * Set when this session is a resume of a terminal session. The
   * job-watcher walks the chain at spawn time to build the session
   * history markdown.
   */
  resumedFromSessionId: SessionId | null;
  triggeredAt: Date;
}

export interface UpdateSessionStatusInput {
  status: SessionStatus;
  completedAt?: Date | null;
  errorMessage?: string | null;
}

export interface SessionRepository {
  /**
   * Insert a new session. Implementations MUST translate a unique-violation
   * on (agent_id, triggered_at) into a `SessionDuplicateTickError` so the
   * scheduler can detect idempotent ticks without reading the error code.
   */
  create(input: CreateSessionInput): Promise<Session>;

  findById(id: SessionId): Promise<Session | null>;

  listByAgent(agentId: AgentId, limit: number): Promise<readonly Session[]>;

  /**
   * Every session across every agent in a workspace, newest-first.
   * Powers the workspace-level sessions list page.
   */
  listByWorkspace(
    workspaceId: WorkspaceId,
    limit: number,
  ): Promise<readonly Session[]>;

  /**
   * Sessions visible to a specific user — sessions they own
   * (triggered_by_user_id = userId) UNION sessions shared with them
   * via session_user_shares. Newest-first. Workspace-scoped.
   *
   * Workspace admins/owners get the full set via listByWorkspace
   * instead — they're trusted to see everything, including
   * scheduler-triggered sessions which have no human owner.
   */
  listForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
    limit: number,
  ): Promise<readonly Session[]>;

  /**
   * The most recent scheduler-triggered session for an agent. Scheduler uses
   * this plus the agent's cron to decide the next due time.
   */
  lastSchedulerRunFor(agentId: AgentId): Promise<Session | null>;

  /**
   * The single non-terminal session for an agent, if any. Orchestrator
   * agents are singletons: at most one session exists in 'pending' or
   * 'running' state per orchestrator at any time. Workers may have
   * many concurrent sessions, so this method is primarily meaningful
   * for orchestrators — callers should only consult it for agents of
   * kind 'orchestrator'.
   *
   * Returns null if no non-terminal session exists (fresh orchestrator
   * or one whose prior session completed / failed cleanly and is ready
   * for a new run).
   */
  findLiveSessionForAgent(agentId: AgentId): Promise<Session | null>;

  /**
   * Child sessions spawned by the given parent. Newest-first. Powers the
   * "Children" panel on the session detail page.
   */
  listChildren(parentSessionId: SessionId): Promise<readonly Session[]>;

  updateStatus(
    id: SessionId,
    patch: UpdateSessionStatusInput,
  ): Promise<Session>;

  /**
   * Sessions still in a non-terminal state (`pending` or `running`)
   * whose `triggered_at` is older than `threshold`. Used by the pod
   * reconciler to find ghost sessions — rows left as "running" after
   * a cluster crash or kubelet restart where the Job-watcher never
   * observed the terminal event. The time threshold is a grace
   * window: don't reap a session that was created seconds ago while
   * its Job is still being applied.
   */
  listNonTerminalOlderThan(threshold: Date): Promise<readonly Session[]>;
}
