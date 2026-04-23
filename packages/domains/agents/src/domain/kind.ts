import { ValidationError } from "@x1agent/kernel";

/**
 * Agent kind — the pod-lifecycle discriminator.
 *
 *  - worker:        default; short-lived, one session per trigger.
 *  - orchestrator:  long-lived singleton; one session per agent,
 *                   resumed across pod restarts. Commissions children.
 *  - scheduled:     cron-triggered; one session per tick (same pod
 *                   shape as worker, different trigger semantics).
 *
 * The enum is closed. Adding a new kind is a coordinated change
 * across the schema (CHECK constraint), domain (this file), pod-spec
 * (branching), and docs (architecture/orchestration.md). Doing it as
 * a string with an ad-hoc type breaks those invariants; keep it
 * finite here.
 */
export const AGENT_KINDS = ["worker", "orchestrator", "scheduled"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function AgentKind(raw: string): AgentKind {
  if ((AGENT_KINDS as readonly string[]).includes(raw)) {
    return raw as AgentKind;
  }
  throw new ValidationError(
    "kind",
    `must be one of ${AGENT_KINDS.join(", ")}`,
  );
}

/**
 * Orchestrators are the only kind that carries singleton session
 * semantics. Workers and scheduled agents both create a new session
 * per trigger; orchestrators find-or-create.
 */
export function isOrchestratorKind(kind: AgentKind): boolean {
  return kind === "orchestrator";
}
