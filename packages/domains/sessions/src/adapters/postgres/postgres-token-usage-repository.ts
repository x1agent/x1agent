import type postgres from "postgres";
import type {
  RecordTokenUsageInput,
  TokenUsageByAgent,
  TokenUsageByDay,
  TokenUsageByModel,
  TokenUsageRepository,
  WorkspaceTokenUsageRollup,
} from "../../ports/token-usage-repository.js";

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

const CACHE_READ_MULTIPLIER = 0.10;
const CACHE_WRITE_MULTIPLIER = 1.25;

function priceFor(model: string): { input: number; output: number } {
  const s = model.toLowerCase();
  if (s.includes("opus")) return TIER_PRICES.opus;
  if (s.includes("haiku")) return TIER_PRICES.haiku;
  // Sonnet covers both explicit "sonnet" and any unrecognised model id
  // (matches the prior DEFAULT_PRICE behaviour). Putting it last means
  // the keyword check naturally degrades to "treat unknown as sonnet"
  // rather than silently billing $0 for a new tier we haven't taught.
  return TIER_PRICES.sonnet;
}

export function estimateUsdCost(row: {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}): number {
  const p = priceFor(row.model);
  const millions = (n: number) => n / 1_000_000;
  return (
    millions(row.input_tokens) * p.input +
    millions(row.output_tokens) * p.output +
    millions(row.cache_creation_input_tokens) * (p.input * CACHE_WRITE_MULTIPLIER) +
    millions(row.cache_read_input_tokens) * (p.input * CACHE_READ_MULTIPLIER)
  );
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

    // ── shape into ports ────────────────────────────────────────────
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsdEstimate: 0,
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
      const cost = estimateUsdCost(counts);
      totals.inputTokens += counts.input_tokens;
      totals.outputTokens += counts.output_tokens;
      totals.cacheCreationInputTokens += counts.cache_creation_input_tokens;
      totals.cacheReadInputTokens += counts.cache_read_input_tokens;
      totals.costUsdEstimate += cost;
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
      const cost = estimateUsdCost(counts);
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
      const cost = estimateUsdCost(counts);
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

    return { totals, byAgent, byModel, byDay };
  }
}
