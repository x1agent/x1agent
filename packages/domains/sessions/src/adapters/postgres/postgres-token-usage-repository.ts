import type postgres from "postgres";
import type {
  RecordTokenUsageInput,
  TokenUsageByAgent,
  TokenUsageByDay,
  TokenUsageByModel,
  TokenUsageRepository,
  WorkspaceTokenUsageRollup,
} from "../../ports/token-usage-repository.js";
import {
  collapseByDayByTriggerSource,
  collapseByTriggerSource,
  collapseByUser,
} from "./token-usage-collapse.js";

type Sql = postgres.Sql<Record<string, unknown>>;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

/**
 * Per-million-token USD prices for the Anthropic Claude family.
 *
 * Pricing parity holds across Anthropic direct API, Vertex AI, and
 * Amazon Bedrock for the 4.x generation, so a single tier table covers
 * every channel today.
 *
 * Tier dispatch is by *substring* of the model id rather than exact
 * match. The SDK returns ids like `claude-sonnet-4-5@20250929` on
 * Vertex and `claude-sonnet-4-5-20250929` on direct Anthropic; in
 * either case "sonnet" appears in the id and we land on the right
 * tier without having to enumerate every dated revision Anthropic
 * ships. New models inherit pricing the day they're released.
 *
 * Output is consistently 5× input within a tier across 4.x.
 *
 * Sources (refresh if either Vertex or Anthropic changes):
 *   - Anthropic pricing page (anthropic.com/pricing)
 *   - Vertex Anthropic SKU rates (Cloud Console → Billing → Reports)
 *
 * Cache multipliers are recall and may drift; admin should reconcile
 * against the BigQuery billing export before charging customers from
 * these numbers. cache_read at 10% of input is well-established;
 * cache_creation premium varies by TTL (5-min vs 1-hour) — we use
 * 1.25× as the default for the 5-minute TTL case which the SDK uses.
 */
const TIER_PRICES = {
  opus:   { input: 5.00,  output: 25.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 1.00,  output:  5.00 },
} as const;

export const DEFAULT_CACHE_READ_MULTIPLIER = 0.10;
export const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Tier-classifier defaults for a given model id. Exported so the
 * admin "Claude models" UI can seed its price input placeholders
 * with sensible numbers — the operator only saves when they want to
 * deviate from the default.
 */
export function tierDefaultPrices(model: string): {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
} {
  const s = model.toLowerCase();
  const tier = s.includes("opus")
    ? TIER_PRICES.opus
    : s.includes("haiku")
      ? TIER_PRICES.haiku
      : // Sonnet covers explicit "sonnet" + any unrecognised id; matches
        // the prior DEFAULT_PRICE behaviour rather than billing $0.
        TIER_PRICES.sonnet;
  return {
    inputPerMillion: tier.input,
    outputPerMillion: tier.output,
    cacheReadMultiplier: DEFAULT_CACHE_READ_MULTIPLIER,
    cacheWriteMultiplier: DEFAULT_CACHE_WRITE_MULTIPLIER,
  };
}

/**
 * Per-model price override. Each field is independently optional —
 * an admin can pin only the input rate and let the cache multipliers
 * follow the tier default. Stored in `anthropic_model_overrides`.
 */
export interface PriceOverride {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadMultiplier: number | null;
  cacheWriteMultiplier: number | null;
}

export function estimateUsdCost(
  row: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  },
  override?: PriceOverride,
): number {
  const def = tierDefaultPrices(row.model);
  const inputRate = override?.inputPerMillion ?? def.inputPerMillion;
  const outputRate = override?.outputPerMillion ?? def.outputPerMillion;
  const cacheReadMult =
    override?.cacheReadMultiplier ?? def.cacheReadMultiplier;
  const cacheWriteMult =
    override?.cacheWriteMultiplier ?? def.cacheWriteMultiplier;
  const millions = (n: number) => n / 1_000_000;
  return (
    millions(row.input_tokens) * inputRate +
    millions(row.output_tokens) * outputRate +
    millions(row.cache_creation_input_tokens) * (inputRate * cacheWriteMult) +
    millions(row.cache_read_input_tokens) * (inputRate * cacheReadMult)
  );
}

/**
 * Dollars saved by reading from cache instead of paying full input
 * rate for the same tokens. The per-row formula:
 *
 *   cache_read_tokens × inputRate × (1 − cacheReadMultiplier)
 *
 * cacheReadMultiplier defaults to 0.10 so the typical savings are
 * 0.9 × what those tokens would have cost at full input rate. Surfaces
 * to the dashboard as a single "cache savings" stat — answers the
 * implicit "is prompt caching paying off?" question.
 */
export function estimateUsdCacheSavings(
  row: {
    model: string;
    cache_read_input_tokens: number;
  },
  override?: PriceOverride,
): number {
  const def = tierDefaultPrices(row.model);
  const inputRate = override?.inputPerMillion ?? def.inputPerMillion;
  const cacheReadMult =
    override?.cacheReadMultiplier ?? def.cacheReadMultiplier;
  return (row.cache_read_input_tokens / 1_000_000) * inputRate *
    (1 - cacheReadMult);
}

interface RowAggByModel {
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_creation_input_tokens: string;
  cache_read_input_tokens: string;
}
interface RowAggByAgent {
  agent_id: string | null;
  agent_name: string | null;
  agent_slug: string | null;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_creation_input_tokens: string;
  cache_read_input_tokens: string;
}
interface RowAggByDay {
  day: string;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_creation_input_tokens: string;
  cache_read_input_tokens: string;
}
interface RowAggByTriggerSource {
  triggered_by: string;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_creation_input_tokens: string;
  cache_read_input_tokens: string;
}
interface RowAggByUser {
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_creation_input_tokens: string;
  cache_read_input_tokens: string;
}
interface RowAggByDayByTriggerSource {
  day: string;
  triggered_by: string;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cache_creation_input_tokens: string;
  cache_read_input_tokens: string;
}

function asInt(v: string | number): number {
  return typeof v === "number" ? v : parseInt(v, 10) || 0;
}

export class PostgresTokenUsageRepository implements TokenUsageRepository {
  constructor(private readonly sql: Sql) {}

  async record(input: RecordTokenUsageInput): Promise<void> {
    try {
      await this.sql`
        INSERT INTO token_usage
          (session_id, workspace_id, agent_id, model,
           input_tokens, output_tokens,
           cache_creation_input_tokens, cache_read_input_tokens,
           event_seq, ts)
        VALUES
          (${input.sessionId}, ${input.workspaceId}, ${input.agentId},
           ${input.model},
           ${input.inputTokens}, ${input.outputTokens},
           ${input.cacheCreationInputTokens}, ${input.cacheReadInputTokens},
           ${input.eventSeq}, ${input.ts})
      `;
    } catch (err) {
      if (isUniqueViolation(err)) return; // dedup — no-op
      throw err;
    }
  }

  async rollupForWorkspace(input: {
    workspaceId: string;
    since: Date;
    until: Date;
  }): Promise<WorkspaceTokenUsageRollup> {
    // Per-model price overrides from the admin "Claude models" UI.
    // Each column is independently nullable; a null falls through to
    // the tier-classifier default at cost-compute time. Loaded once
    // here and threaded into each collapse so we don't hit the DB
    // per row.
    const overrideRows = await this.sql<
      {
        model_id: string;
        input_usd_per_million: string | null;
        output_usd_per_million: string | null;
        cache_read_multiplier: string | null;
        cache_write_multiplier: string | null;
      }[]
    >`
      SELECT model_id,
             input_usd_per_million,
             output_usd_per_million,
             cache_read_multiplier,
             cache_write_multiplier
      FROM anthropic_model_overrides
      WHERE input_usd_per_million IS NOT NULL
         OR output_usd_per_million IS NOT NULL
         OR cache_read_multiplier  IS NOT NULL
         OR cache_write_multiplier IS NOT NULL
    `;
    const overrides = new Map<string, PriceOverride>();
    for (const r of overrideRows) {
      overrides.set(r.model_id, {
        inputPerMillion:
          r.input_usd_per_million === null ? null : Number(r.input_usd_per_million),
        outputPerMillion:
          r.output_usd_per_million === null ? null : Number(r.output_usd_per_million),
        cacheReadMultiplier:
          r.cache_read_multiplier === null ? null : Number(r.cache_read_multiplier),
        cacheWriteMultiplier:
          r.cache_write_multiplier === null ? null : Number(r.cache_write_multiplier),
      });
    }

    // Three GROUP BY queries instead of one — Postgres planner handles
    // each cleanly via the (workspace_id, ts DESC) index, and parsing
    // back into three structures is trivial. One mega-query with
    // ROLLUP would be denser but harder to read.
    const byModelRows = await this.sql<RowAggByModel[]>`
      SELECT model,
             SUM(input_tokens)::TEXT                  AS input_tokens,
             SUM(output_tokens)::TEXT                 AS output_tokens,
             SUM(cache_creation_input_tokens)::TEXT   AS cache_creation_input_tokens,
             SUM(cache_read_input_tokens)::TEXT       AS cache_read_input_tokens
      FROM token_usage
      WHERE workspace_id = ${input.workspaceId}
        AND ts >= ${input.since}
        AND ts <  ${input.until}
      GROUP BY model
    `;
    const byAgentRows = await this.sql<RowAggByAgent[]>`
      SELECT tu.agent_id,
             a.name AS agent_name,
             a.slug AS agent_slug,
             tu.model,
             SUM(tu.input_tokens)::TEXT                  AS input_tokens,
             SUM(tu.output_tokens)::TEXT                 AS output_tokens,
             SUM(tu.cache_creation_input_tokens)::TEXT   AS cache_creation_input_tokens,
             SUM(tu.cache_read_input_tokens)::TEXT       AS cache_read_input_tokens
      FROM token_usage tu
      LEFT JOIN agents a ON a.id = tu.agent_id
      WHERE tu.workspace_id = ${input.workspaceId}
        AND tu.ts >= ${input.since}
        AND tu.ts <  ${input.until}
      GROUP BY tu.agent_id, a.name, a.slug, tu.model
    `;
    const byDayRows = await this.sql<RowAggByDay[]>`
      SELECT TO_CHAR(date_trunc('day', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             model,
             SUM(input_tokens)::TEXT                  AS input_tokens,
             SUM(output_tokens)::TEXT                 AS output_tokens,
             SUM(cache_creation_input_tokens)::TEXT   AS cache_creation_input_tokens,
             SUM(cache_read_input_tokens)::TEXT       AS cache_read_input_tokens
      FROM token_usage
      WHERE workspace_id = ${input.workspaceId}
        AND ts >= ${input.since}
        AND ts <  ${input.until}
      GROUP BY day, model
      ORDER BY day ASC
    `;
    // Three trigger-source-aware queries. They all join sessions to
    // pick up triggered_by + triggered_by_user_id; the planner uses
    // the (workspace_id, ts DESC) index on token_usage and the PK on
    // sessions, so this stays cheap. We don't bother with a single
    // mega-query because the GROUP BY shapes are different and JS
    // collation is trivial.
    const byTriggerSourceRows = await this.sql<RowAggByTriggerSource[]>`
      SELECT s.triggered_by                              AS triggered_by,
             tu.model                                    AS model,
             SUM(tu.input_tokens)::TEXT                  AS input_tokens,
             SUM(tu.output_tokens)::TEXT                 AS output_tokens,
             SUM(tu.cache_creation_input_tokens)::TEXT   AS cache_creation_input_tokens,
             SUM(tu.cache_read_input_tokens)::TEXT       AS cache_read_input_tokens
      FROM token_usage tu
      JOIN sessions s ON s.id = tu.session_id
      WHERE tu.workspace_id = ${input.workspaceId}
        AND tu.ts >= ${input.since}
        AND tu.ts <  ${input.until}
      GROUP BY s.triggered_by, tu.model
    `;
    const byUserRows = await this.sql<RowAggByUser[]>`
      SELECT s.triggered_by_user_id                      AS user_id,
             u.name                                      AS user_name,
             u.email                                     AS user_email,
             tu.model                                    AS model,
             SUM(tu.input_tokens)::TEXT                  AS input_tokens,
             SUM(tu.output_tokens)::TEXT                 AS output_tokens,
             SUM(tu.cache_creation_input_tokens)::TEXT   AS cache_creation_input_tokens,
             SUM(tu.cache_read_input_tokens)::TEXT       AS cache_read_input_tokens
      FROM token_usage tu
      JOIN sessions s ON s.id = tu.session_id
      LEFT JOIN users u ON u.id = s.triggered_by_user_id
      WHERE tu.workspace_id = ${input.workspaceId}
        AND tu.ts >= ${input.since}
        AND tu.ts <  ${input.until}
        AND s.triggered_by = 'user'
        AND s.triggered_by_user_id IS NOT NULL
      GROUP BY s.triggered_by_user_id, u.name, u.email, tu.model
    `;
    const byDayByTriggerSourceRows = await this.sql<
      RowAggByDayByTriggerSource[]
    >`
      SELECT TO_CHAR(date_trunc('day', tu.ts AT TIME ZONE 'UTC'),
                     'YYYY-MM-DD')                      AS day,
             s.triggered_by                              AS triggered_by,
             tu.model                                    AS model,
             SUM(tu.input_tokens)::TEXT                  AS input_tokens,
             SUM(tu.output_tokens)::TEXT                 AS output_tokens,
             SUM(tu.cache_creation_input_tokens)::TEXT   AS cache_creation_input_tokens,
             SUM(tu.cache_read_input_tokens)::TEXT       AS cache_read_input_tokens
      FROM token_usage tu
      JOIN sessions s ON s.id = tu.session_id
      WHERE tu.workspace_id = ${input.workspaceId}
        AND tu.ts >= ${input.since}
        AND tu.ts <  ${input.until}
      GROUP BY day, s.triggered_by, tu.model
      ORDER BY day ASC
    `;

    // ── shape into ports ────────────────────────────────────────────
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsdEstimate: 0,
      cacheSavingsUsdEstimate: 0,
    };

    // Per-model rollup is the cleanest place to compute totals because
    // pricing is per-model.
    const byModel: TokenUsageByModel[] = byModelRows.map((r) => {
      const counts = {
        model: r.model,
        input_tokens: asInt(r.input_tokens),
        output_tokens: asInt(r.output_tokens),
        cache_creation_input_tokens: asInt(r.cache_creation_input_tokens),
        cache_read_input_tokens: asInt(r.cache_read_input_tokens),
      };
      const override = overrides.get(counts.model);
      const cost = estimateUsdCost(counts, override);
      const savings = estimateUsdCacheSavings(counts, override);
      totals.inputTokens += counts.input_tokens;
      totals.outputTokens += counts.output_tokens;
      totals.cacheCreationInputTokens += counts.cache_creation_input_tokens;
      totals.cacheReadInputTokens += counts.cache_read_input_tokens;
      totals.costUsdEstimate += cost;
      totals.cacheSavingsUsdEstimate =
        (totals.cacheSavingsUsdEstimate ?? 0) + savings;
      return {
        model: counts.model,
        inputTokens: counts.input_tokens,
        outputTokens: counts.output_tokens,
        cacheCreationInputTokens: counts.cache_creation_input_tokens,
        cacheReadInputTokens: counts.cache_read_input_tokens,
        costUsdEstimate: cost,
      };
    });
    byModel.sort((a, b) => b.costUsdEstimate - a.costUsdEstimate);

    // byAgent comes in agent×model granularity from SQL; collapse to
    // per-agent in code so the dashboard's primary table is per-agent.
    const agentMap = new Map<string, TokenUsageByAgent>();
    for (const r of byAgentRows) {
      const key = r.agent_id ?? "__null__";
      const counts = {
        model: r.model,
        input_tokens: asInt(r.input_tokens),
        output_tokens: asInt(r.output_tokens),
        cache_creation_input_tokens: asInt(r.cache_creation_input_tokens),
        cache_read_input_tokens: asInt(r.cache_read_input_tokens),
      };
      const cost = estimateUsdCost(counts, overrides.get(counts.model));
      const existing = agentMap.get(key);
      if (existing) {
        existing.inputTokens += counts.input_tokens;
        existing.outputTokens += counts.output_tokens;
        existing.cacheCreationInputTokens += counts.cache_creation_input_tokens;
        existing.cacheReadInputTokens += counts.cache_read_input_tokens;
        existing.costUsdEstimate += cost;
      } else {
        agentMap.set(key, {
          agentId: r.agent_id,
          agentName: r.agent_name,
          agentSlug: r.agent_slug,
          inputTokens: counts.input_tokens,
          outputTokens: counts.output_tokens,
          cacheCreationInputTokens: counts.cache_creation_input_tokens,
          cacheReadInputTokens: counts.cache_read_input_tokens,
          costUsdEstimate: cost,
        });
      }
    }
    const byAgent = Array.from(agentMap.values()).sort(
      (a, b) => b.costUsdEstimate - a.costUsdEstimate,
    );

    // byDay: same per-model collapse pattern, keyed on day string.
    const dayMap = new Map<string, TokenUsageByDay>();
    for (const r of byDayRows) {
      const counts = {
        model: r.model,
        input_tokens: asInt(r.input_tokens),
        output_tokens: asInt(r.output_tokens),
        cache_creation_input_tokens: asInt(r.cache_creation_input_tokens),
        cache_read_input_tokens: asInt(r.cache_read_input_tokens),
      };
      const cost = estimateUsdCost(counts, overrides.get(counts.model));
      const existing = dayMap.get(r.day);
      if (existing) {
        existing.inputTokens += counts.input_tokens;
        existing.outputTokens += counts.output_tokens;
        existing.cacheCreationInputTokens += counts.cache_creation_input_tokens;
        existing.cacheReadInputTokens += counts.cache_read_input_tokens;
        existing.costUsdEstimate += cost;
      } else {
        dayMap.set(r.day, {
          day: r.day,
          inputTokens: counts.input_tokens,
          outputTokens: counts.output_tokens,
          cacheCreationInputTokens: counts.cache_creation_input_tokens,
          cacheReadInputTokens: counts.cache_read_input_tokens,
          costUsdEstimate: cost,
        });
      }
    }
    const byDay = Array.from(dayMap.values()).sort((a, b) =>
      a.day.localeCompare(b.day),
    );

    // Trigger-source / user / daily-by-trigger collapses live in
    // token-usage-collapse so the row→rollup math is unit-testable
    // without standing up Postgres.
    const byTriggerSource = collapseByTriggerSource(
      byTriggerSourceRows,
      overrides,
    );
    const byUser = collapseByUser(byUserRows, overrides);
    const byDayByTriggerSource = collapseByDayByTriggerSource(
      byDayByTriggerSourceRows,
      overrides,
    );

    return {
      totals,
      byAgent,
      byModel,
      byDay,
      byTriggerSource,
      byUser,
      byDayByTriggerSource,
    };
  }
}
