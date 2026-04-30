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

export interface WorkspaceTokenUsageRollup {
  totals: TokenUsageTotals;
  byAgent: TokenUsageByAgent[];
  byModel: TokenUsageByModel[];
  byDay: TokenUsageByDay[];
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
