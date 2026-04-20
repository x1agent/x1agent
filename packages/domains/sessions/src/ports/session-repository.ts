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
   * The most recent scheduler-triggered session for an agent. Scheduler uses
   * this plus the agent's cron to decide the next due time.
   */
  lastSchedulerRunFor(agentId: AgentId): Promise<Session | null>;

  /**
   * Child sessions spawned by the given parent. Newest-first. Powers the
   * "Children" panel on the session detail page.
   */
  listChildren(parentSessionId: SessionId): Promise<readonly Session[]>;

  updateStatus(
    id: SessionId,
    patch: UpdateSessionStatusInput,
  ): Promise<Session>;
}
