import { describe, it, expect } from "bun:test";
import { estimateUsdCost } from "./postgres-token-usage-repository.js";

/**
 * Pricing pinned here so the dashboards aren't drifting silently from
 * what we tell customers we charge. If Anthropic / Vertex change
 * prices the tests fail with a clear message and we update the tier
 * table + these expectations together.
 *
 * Numbers come from the Vertex AI Anthropic SKU rates (parity with
 * Anthropic direct as of 2026-05): Sonnet $3/$15, Opus 4.x $5/$25,
 * Haiku 4.x $1/$5. Output is 5× input. Cache read 0.10× input,
 * cache write 1.25× input.
 */

describe("estimateUsdCost — tier dispatch", () => {
  it("classifies opus by substring (handles dated + Vertex @-suffixed ids)", () => {
    // 1M input tokens → $5 (no cache, no output).
    expect(
      estimateUsdCost({
        model: "claude-opus-4-7",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(5.0, 6);

    expect(
      estimateUsdCost({
        model: "claude-opus-5-1@20260615",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(5.0, 6);
  });

  it("classifies haiku by substring", () => {
    expect(
      estimateUsdCost({
        model: "claude-haiku-4-5-20251001",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(1.0 + 5.0, 6);
  });

  it("falls back to sonnet for explicit sonnet ids and unknown ids", () => {
    // Explicit sonnet.
    expect(
      estimateUsdCost({
        model: "claude-sonnet-4-5@20250929",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(3.0, 6);
    // No tier keyword in the string — match the prior DEFAULT_PRICE
    // behaviour rather than billing zero. Sonnet rate is the safe
    // default for "we shipped a new tier we don't know about yet".
    expect(
      estimateUsdCost({
        model: "unknown",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeCloseTo(3.0 + 15.0, 6);
  });
});

describe("estimateUsdCost — cache multipliers", () => {
  // Use sonnet ($3 input) so the math is easy to read.
  const sonnet = (counts: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }) =>
    estimateUsdCost({
      model: "claude-sonnet-4-5",
      input_tokens: counts.input_tokens ?? 0,
      output_tokens: counts.output_tokens ?? 0,
      cache_creation_input_tokens: counts.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: counts.cache_read_input_tokens ?? 0,
    });

  it("bills cache_read at 0.10× input rate", () => {
    // 1M cache-read tokens at sonnet ($3 input) × 0.10 = $0.30.
    expect(sonnet({ cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.3, 6);
  });

  it("bills cache_creation at 1.25× input rate (5-min TTL premium)", () => {
    // 1M cache-write tokens at sonnet ($3 input) × 1.25 = $3.75.
    expect(sonnet({ cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(
      3.75,
      6,
    );
  });

  it("sums every bucket without double-counting", () => {
    // 100k each across all four buckets at sonnet:
    //   input:  100k × $3.00  / 1M = $0.30
    //   output: 100k × $15.00 / 1M = $1.50
    //   write:  100k × $3.75  / 1M = $0.375
    //   read:   100k × $0.30  / 1M = $0.03
    //   total = $2.205
    expect(
      sonnet({
        input_tokens: 100_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 100_000,
        cache_read_input_tokens: 100_000,
      }),
    ).toBeCloseTo(2.205, 6);
  });
});
