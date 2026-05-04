import type { SessionId } from "../domain/session.js";

/**
 * Per-turn LLM token usage. One row per agent.usage event off NATS.
 * The repository owns idempotency: same (session_id, event_seq) writes
 * are no-ops, not errors, so a NATS replay never double-counts.
 */
export interface RecordTokenUsageInput {
  sessionId: SessionId;
  workspaceId: string;
  agentId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /**
   * NATS envelope sequence — dedup key with sessionId. Same value
   * passed to SessionEventRepository.append for the same NATS message.
   */
  eventSeq: number;
  ts: Date;
}

/**
 * Aggregated rollup for one slice of token-usage history.
 * `cost_usd_estimate` is computed at query time from a static price
 * table (see postgres-token-usage-repository.ts MODEL_PRICES). Future:
 * pull live prices from a settings table so operators can override.
 */
export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsdEstimate: number;
}

export interface TokenUsageByAgent extends TokenUsageTotals {
  agentId: string | null;
  /** Joined from agents.name; null when agentId is null (orphaned row). */
  agentName: string | null;
  /** Joined from agents.slug; null same as above. */
  agentSlug: string | null;
}

export interface TokenUsageByModel extends TokenUsageTotals {
  model: string;
}

export interface TokenUsageByDay extends TokenUsageTotals {
  /** YYYY-MM-DD in UTC. */
  day: string;
}

/**
 * Where the session that produced these rows came from. `user` means a
 * human clicked New session / sent a message; `scheduler` means a cron
 * tick fired; `agent` means an orchestrator spawned a child. Lets the
 * dashboard separate human-driven spend from automated runs.
 */
export type TriggerSource = "user" | "scheduler" | "agent";

export interface TokenUsageByTriggerSource extends TokenUsageTotals {
  triggeredBy: TriggerSource;
}

/**
 * Spend attributed to a specific human user. Only counts rows whose
 * underlying session was `triggered_by='user'`. Scheduler / agent rows
 * have no user attribution by design (see migrations/009 CHECK).
 */
export interface TokenUsageByUser extends TokenUsageTotals {
  userId: string;
  /** Joined from users.name; null if the user row was deleted. */
  userName: string | null;
  /** Joined from users.email; null if the user row was deleted. */
  userEmail: string | null;
}

/**
 * Daily breakdown sliced by trigger source — feeds the stacked area
 * chart that shows the human-vs-automated spend split over time.
 * Same day appears multiple times, once per non-zero trigger source.
 */
export interface TokenUsageByDayByTriggerSource extends TokenUsageTotals {
  /** YYYY-MM-DD in UTC. */
  day: string;
  triggeredBy: TriggerSource;
}

export interface WorkspaceTokenUsageRollup {
  totals: TokenUsageTotals;
  byAgent: TokenUsageByAgent[];
  byModel: TokenUsageByModel[];
  byDay: TokenUsageByDay[];
  byTriggerSource: TokenUsageByTriggerSource[];
  byUser: TokenUsageByUser[];
  byDayByTriggerSource: TokenUsageByDayByTriggerSource[];
}

export interface TokenUsageRepository {
  /**
   * Insert one row. On unique violation of (session_id, event_seq)
   * implementations MUST swallow the error and return — the caller
   * treats this as a successful no-op.
   */
  record(input: RecordTokenUsageInput): Promise<void>;

  /**
   * Workspace-scoped rollup for the dashboard. `since` is inclusive,
   * `until` exclusive. byAgent + byModel sorted by total cost desc;
   * byDay sorted ascending so the chart renders left-to-right.
   */
  rollupForWorkspace(input: {
    workspaceId: string;
    since: Date;
    until: Date;
  }): Promise<WorkspaceTokenUsageRollup>;
}
