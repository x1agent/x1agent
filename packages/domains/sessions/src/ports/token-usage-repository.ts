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
  /**
   * Estimate of dollars saved by serving prompt tokens from the
   * cache instead of paying full input rate. Computed alongside
   * costUsdEstimate from the same per-model rate table; `null` on
   * leaf slices (byAgent / byModel / byUser / byDay etc) where
   * we don't bother surfacing it. Only the top-level `totals`
   * carries a real number.
   */
  cacheSavingsUsdEstimate?: number;
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

/**
 * Per-session rollup for the "this session" cost block on the session
 * detail page. Workspace-scoped at the repository call site — the route
 * verifies sessionId belongs to workspaceId before invoking this.
 */
export interface SessionTokenUsageRollup {
  sessionId: string;
  totals: TokenUsageTotals;
  byModel: TokenUsageByModel[];
}

/**
 * Per-child row in a session-tree rollup. One row per descendant
 * session that produced any token usage. The parent's own usage is
 * reported separately on the enclosing tree rollup.
 */
export interface SessionTreeChildCost extends TokenUsageTotals {
  sessionId: string;
  /** Depth from the root parent: 1 = direct child, 2 = grandchild, … */
  depth: number;
  /** LLM-generated session summary, when available. */
  summary: string | null;
  /** Joined from agents.slug — null when the agent row was deleted. */
  agentSlug: string | null;
  /** Joined from agents.name. */
  agentName: string | null;
}

/**
 * Parent + transitively-spawned children, with the parent's own row
 * and a flat children list. `totals` includes the parent and every
 * descendant — that's the "tree cost" the orchestrator standup quotes.
 */
export interface SessionTreeRollup {
  rootSessionId: string;
  /** The root parent's own usage — not including any descendants. */
  parent: SessionTokenUsageRollup;
  /** Every descendant that produced any usage, deepest-first. */
  children: SessionTreeChildCost[];
  /** Parent + every descendant rolled into one number. */
  totals: TokenUsageTotals;
}

/**
 * Agent-scoped rollup across every session the agent ever ran in a
 * given window. Powers View 3 on the agent detail page — totals stat,
 * byDay sparkline, byModel breakdown for the tooltip, and a top-N
 * sessions list for "where did the spend land?".
 */
export interface AgentSessionCost extends TokenUsageTotals {
  sessionId: string;
  /** First event timestamp on the session, ISO-8601 string in UTC. */
  startedAt: string;
  summary: string | null;
}

export interface AgentTokenUsageRollup {
  agentId: string;
  window: AgentCostWindow;
  totals: TokenUsageTotals;
  byModel: TokenUsageByModel[];
  byDay: TokenUsageByDay[];
  /**
   * Top-N sessions by cost, descending. Caps at 10 so the page table
   * doesn't drift into "scrollable wall" territory; if the orchestrator
   * needs the full set it can hit `/api/.../sessions` instead.
   */
  topSessions: AgentSessionCost[];
}

/**
 * Time windows for the agent-page rollup. Locked by greenlit mockup
 * decision — 7d is the default the standup negotiates against; the
 * other three are toggles. "all" means "from the beginning of time".
 */
export type AgentCostWindow = "24h" | "7d" | "30d" | "all";

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

  /**
   * Per-session cost — the live tally for one session. Implementations
   * MUST scope the query by workspaceId in addition to sessionId so a
   * cross-tenant id leak in the caller still returns an empty rollup
   * rather than another workspace's spend.
   *
   * Empty session (no usage yet) returns zero totals and an empty
   * byModel — not null. The "this session" block always renders.
   */
  rollupForSession(input: {
    sessionId: string;
    workspaceId: string;
  }): Promise<SessionTokenUsageRollup>;

  /**
   * Parent + every transitively-spawned child, aggregated. Uses a
   * recursive CTE to walk session.parent_session_id; depth-limited at
   * the adapter to keep a cycle-bug from melting the query planner.
   *
   * Workspace-scoped same way as rollupForSession.
   */
  rollupForSessionTree(input: {
    sessionId: string;
    workspaceId: string;
  }): Promise<SessionTreeRollup>;

  /**
   * Agent-scoped rollup over every session the agent ran in the
   * window. workspaceId in the WHERE clause is load-bearing — we do
   * not trust agentId alone.
   */
  rollupForAgent(input: {
    agentId: string;
    workspaceId: string;
    window: AgentCostWindow;
    /** Wall-clock anchor used to compute the window bounds. */
    now: Date;
  }): Promise<AgentTokenUsageRollup>;
}
