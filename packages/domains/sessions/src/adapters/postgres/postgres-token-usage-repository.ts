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
 * Per-million-token USD prices, by model id. Source: anthropic.com/pricing
 * snapshot; refresh when the operator notices drift. Keys match the model
 * strings the SDK returns in the `result.model` field.
 *
 * cache_creation is billed at the input rate; cache_read is 10% of input.
 * Numbers below are input/output per million tokens; cache rates derived.
 *
 * Unknown models fall back to the costliest current Sonnet rate to avoid
 * silently underestimating spend.
 */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":            { input: 15.00, output: 75.00 },
  "claude-opus-4-6":            { input: 15.00, output: 75.00 },
  "claude-sonnet-4-6":          { input:  3.00, output: 15.00 },
  "claude-sonnet-4-5":          { input:  3.00, output: 15.00 },
  "claude-haiku-4-5":           { input:  0.80, output:  4.00 },
  "claude-haiku-4-5-20251001":  { input:  0.80, output:  4.00 },
};

const DEFAULT_PRICE = { input: 3.00, output: 15.00 };

function priceFor(model: string): { input: number; output: number } {
  return MODEL_PRICES[model] ?? DEFAULT_PRICE;
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
    millions(row.cache_creation_input_tokens) * p.input +
    millions(row.cache_read_input_tokens) * (p.input * 0.1)
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
