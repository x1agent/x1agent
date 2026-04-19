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
  triggeredAt: Date;
  status: SessionStatus;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
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
