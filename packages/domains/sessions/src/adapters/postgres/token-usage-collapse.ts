import type {
  TokenUsageByDayByTriggerSource,
  TokenUsageByTriggerSource,
  TokenUsageByUser,
  TriggerSource,
} from "../../ports/token-usage-repository.js";
import { estimateUsdCost } from "./postgres-token-usage-repository.js";

/**
 * Pure collapse helpers used by the postgres token-usage adapter.
 * Lifted out so the row→rollup math is unit-testable without a live
 * database connection. The SQL queries themselves are covered at
 * integration time.
 *
 * Each helper takes the raw row shape (string-typed counts because
 * `postgres` returns BIGINT as strings to preserve precision) and
 * returns a fully-collapsed rollup with cost estimates baked in.
 */

interface CountRow {
  model: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_creation_input_tokens: string | number;
  cache_read_input_tokens: string | number;
}

export interface RawTriggerSourceRow extends CountRow {
  triggered_by: string;
}

export interface RawUserRow extends CountRow {
  user_id: string;
  user_name: string | null;
  user_email: string | null;
}

export interface RawDayTriggerRow extends CountRow {
  day: string;
  triggered_by: string;
}

function asInt(v: string | number): number {
  return typeof v === "number" ? v : parseInt(v, 10) || 0;
}

/**
 * Defensive triggered_by parser. The DB has a CHECK constraint
 * limiting the column to {user, scheduler, agent}, but if anything
 * slipped past historically (e.g. data restore, future enum value)
 * we attribute it to 'user' rather than silently dropping the row's
 * spend.
 */
function asTriggerSource(raw: string): TriggerSource {
  if (raw === "scheduler" || raw === "agent") return raw;
  return "user";
}

function intoCounts(r: CountRow) {
  return {
    model: r.model,
    input_tokens: asInt(r.input_tokens),
    output_tokens: asInt(r.output_tokens),
    cache_creation_input_tokens: asInt(r.cache_creation_input_tokens),
    cache_read_input_tokens: asInt(r.cache_read_input_tokens),
  };
}

export function collapseByTriggerSource(
  rows: readonly RawTriggerSourceRow[],
): TokenUsageByTriggerSource[] {
  const map = new Map<TriggerSource, TokenUsageByTriggerSource>();
  for (const r of rows) {
    const triggeredBy = asTriggerSource(r.triggered_by);
    const counts = intoCounts(r);
    const cost = estimateUsdCost(counts);
    const existing = map.get(triggeredBy);
    if (existing) {
      existing.inputTokens += counts.input_tokens;
      existing.outputTokens += counts.output_tokens;
      existing.cacheCreationInputTokens += counts.cache_creation_input_tokens;
      existing.cacheReadInputTokens += counts.cache_read_input_tokens;
      existing.costUsdEstimate += cost;
    } else {
      map.set(triggeredBy, {
        triggeredBy,
        inputTokens: counts.input_tokens,
        outputTokens: counts.output_tokens,
        cacheCreationInputTokens: counts.cache_creation_input_tokens,
        cacheReadInputTokens: counts.cache_read_input_tokens,
        costUsdEstimate: cost,
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.costUsdEstimate - a.costUsdEstimate,
  );
}

export function collapseByUser(rows: readonly RawUserRow[]): TokenUsageByUser[] {
  const map = new Map<string, TokenUsageByUser>();
  for (const r of rows) {
    const counts = intoCounts(r);
    const cost = estimateUsdCost(counts);
    const existing = map.get(r.user_id);
    if (existing) {
      existing.inputTokens += counts.input_tokens;
      existing.outputTokens += counts.output_tokens;
      existing.cacheCreationInputTokens += counts.cache_creation_input_tokens;
      existing.cacheReadInputTokens += counts.cache_read_input_tokens;
      existing.costUsdEstimate += cost;
    } else {
      map.set(r.user_id, {
        userId: r.user_id,
        userName: r.user_name,
        userEmail: r.user_email,
        inputTokens: counts.input_tokens,
        outputTokens: counts.output_tokens,
        cacheCreationInputTokens: counts.cache_creation_input_tokens,
        cacheReadInputTokens: counts.cache_read_input_tokens,
        costUsdEstimate: cost,
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.costUsdEstimate - a.costUsdEstimate,
  );
}

export function collapseByDayByTriggerSource(
  rows: readonly RawDayTriggerRow[],
): TokenUsageByDayByTriggerSource[] {
  const map = new Map<string, TokenUsageByDayByTriggerSource>();
  for (const r of rows) {
    const triggeredBy = asTriggerSource(r.triggered_by);
    const key = `${r.day}|${triggeredBy}`;
    const counts = intoCounts(r);
    const cost = estimateUsdCost(counts);
    const existing = map.get(key);
    if (existing) {
      existing.inputTokens += counts.input_tokens;
      existing.outputTokens += counts.output_tokens;
      existing.cacheCreationInputTokens += counts.cache_creation_input_tokens;
      existing.cacheReadInputTokens += counts.cache_read_input_tokens;
      existing.costUsdEstimate += cost;
    } else {
      map.set(key, {
        day: r.day,
        triggeredBy,
        inputTokens: counts.input_tokens,
        outputTokens: counts.output_tokens,
        cacheCreationInputTokens: counts.cache_creation_input_tokens,
        cacheReadInputTokens: counts.cache_read_input_tokens,
        costUsdEstimate: cost,
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.triggeredBy.localeCompare(b.triggeredBy),
  );
}
