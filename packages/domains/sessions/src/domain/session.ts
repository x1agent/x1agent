import { DomainError } from "@x1agent/kernel";
import type { UserId } from "@x1agent/kernel";
import type { AgentId } from "@x1agent/domain-agents";
import type { SessionStatus } from "./status.js";
import type { TriggerSource } from "./trigger.js";

declare const sessionIdBrand: unique symbol;
export type SessionId = string & { readonly [sessionIdBrand]: true };
export const SessionId = (raw: string): SessionId => raw as SessionId;

/**
 * One run of an agent. `triggeredBy` is either a user (with
 * `triggeredByUserId` set) or the platform scheduler (user id is null).
 * `triggeredAt` is the logical run time — for user runs, "now"; for
 * scheduler runs, the computed cron slot, which is what makes the unique
 * (agent_id, triggered_at) index an idempotency key.
 */
export interface Session {
  id: SessionId;
  agentId: AgentId;
  triggeredBy: TriggerSource;
  triggeredByUserId: UserId | null;
  /** Set only when triggeredBy === "agent" — the orchestrator session. */
  parentSessionId: SessionId | null;
  /** Set only when triggeredBy === "agent" — the orchestrator's agent. */
  parentAgentId: AgentId | null;
  /**
   * Previous session this one is a continuation of. Set when an admin
   * clicks Resume on a terminal session; the job-watcher walks the
   * chain at spawn time to build `/workspace/session_history.md`.
   * Null for fresh sessions (including scheduler ticks and orchestrator
   * spawns).
   */
  resumedFromSessionId: SessionId | null;
  triggeredAt: Date;
  status: SessionStatus;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  /**
   * LLM-generated 1-line description of what this session is doing.
   * Periodically (re)written by the api's summarizer — see
   * packages/api/src/nats/subscriber.ts. NULL when the session is
   * brand-new or has too few events to summarize; the UI falls back
   * to the session id hash in that case.
   */
  summary: string | null;
  /** When `summary` was last (re)generated. NULL while summary is NULL. */
  summaryUpdatedAt: Date | null;
  /**
   * Highest session_events.seq included in the current `summary`.
   * Used by the regenerate trigger to skip work when too few new
   * events have arrived since the last summary.
   */
  summaryEventSeq: number | null;
  /**
   * Per-spawn Claude model override (X1A-40). Set by the orchestrator
   * when it calls `spawn_session` with a `model` argument; null on
   * user-triggered and scheduler-triggered sessions, which inherit the
   * child agent's `model` column (then the deployment-wide
   * ANTHROPIC_MODEL env). Pod-spec precedence:
   *   session.modelOverride > agent.model > cfg.anthropicModel.
   * The admin-curated enabled-models allowlist is enforced at the
   * spawn route before the value lands on the row, so this field can
   * be trusted to hold a model the platform admin has enabled.
   */
  modelOverride: string | null;
}

export class SessionNotFoundError extends DomainError {
  readonly code = "session_not_found";
  constructor(public readonly id: string) {
    super(`session ${id} not found`);
  }
}

export class SessionAlreadyTerminalError extends DomainError {
  readonly code = "session_already_terminal";
  constructor(public readonly id: string, public readonly status: SessionStatus) {
    super(`session ${id} is already ${status}`);
  }
}

export class SessionDuplicateTickError extends DomainError {
  readonly code = "session_duplicate_tick";
  constructor(
    public readonly agentId: string,
    public readonly triggeredAt: Date,
  ) {
    super(
      `scheduler tick for agent ${agentId} at ${triggeredAt.toISOString()} already recorded`,
    );
  }
}
