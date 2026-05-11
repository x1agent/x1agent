import type { SessionDTO } from "@x1agent/shared";
import { Badge, type BadgeVariant } from "../../components/ui/badge";

export type AgentRuntimeState = "running" | "idle" | "paused";

interface Props {
  /**
   * Schedule-toggle state — `agents.is_active` from the API. True
   * means the scheduler will spawn runs; false means the agent is
   * intentionally turned off.
   */
  isActive: boolean;
  /**
   * Recent sessions for this agent. We only look at status; "running"
   * trumps the schedule toggle for display purposes because what the
   * user wants to see at a glance is "is this agent doing something
   * right now".
   */
  sessions: ReadonlyArray<Pick<SessionDTO, "status">>;
}

/**
 * The badge in the agent detail header. Three states:
 *
 *   running — at least one session is in `running` status.
 *   idle    — schedule is on but no session is currently running.
 *   paused  — schedule is off (`is_active === false`).
 *
 * Runtime activity wins over schedule state: a "paused" agent that
 * still has a live session reads as "running" because that's what's
 * actually happening. Symmetrically, a scheduled agent with zero live
 * sessions is "idle", not "active" — the previous behaviour of
 * conflating "schedule-enabled" with "active" was misleading on this
 * page (X1A-11).
 *
 * `is_active` semantics are unchanged elsewhere — surfaces that want
 * "is the schedule on" should keep reading the field directly.
 */
export function deriveAgentRuntimeState(
  isActive: boolean,
  sessions: ReadonlyArray<Pick<SessionDTO, "status">>,
): AgentRuntimeState {
  if (sessions.some((s) => s.status === "running")) return "running";
  if (!isActive) return "paused";
  return "idle";
}

const VARIANT: Record<AgentRuntimeState, BadgeVariant> = {
  running: "success",
  idle: "secondary",
  paused: "outline",
};

export function AgentRuntimeBadge({ isActive, sessions }: Props) {
  const state = deriveAgentRuntimeState(isActive, sessions);
  return <Badge variant={VARIANT[state]}>{state}</Badge>;
}
