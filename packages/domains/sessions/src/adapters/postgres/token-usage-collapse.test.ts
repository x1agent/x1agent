import { describe, it, expect } from "bun:test";
import {
  collapseByDayByTriggerSource,
  collapseByTriggerSource,
  collapseByUser,
} from "./token-usage-collapse.js";

/**
 * Sonnet rate: $3 input, $15 output, cache write 1.25× input ($3.75),
 * cache read 0.10× input ($0.30). Numbers below use 1M-token chunks
 * so the expected dollars stay readable.
 */
const M = 1_000_000;

describe("collapseByTriggerSource", () => {
  it("groups rows by triggered_by and sums tokens + cost", () => {
    const out = collapseByTriggerSource([
      // user · 1M sonnet input → $3
      {
        triggered_by: "user",
        model: "claude-sonnet-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
      // user · 1M sonnet output → $15
      {
        triggered_by: "user",
        model: "claude-sonnet-4-5",
        input_tokens: "0",
        output_tokens: String(M),
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
      // scheduler · 1M opus input → $5 (Opus tier per current table)
      {
        triggered_by: "scheduler",
        model: "claude-opus-4-7",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
    ]);

    // user comes first (higher cost), scheduler second.
    expect(out.map((r) => r.triggeredBy)).toEqual(["user", "scheduler"]);
    expect(out[0]!.costUsdEstimate).toBeCloseTo(18, 6);
    expect(out[1]!.costUsdEstimate).toBeCloseTo(5, 6);
    expect(out[0]!.inputTokens).toBe(M);
    expect(out[0]!.outputTokens).toBe(M);
  });

  it("defensively maps unknown trigger_by strings to 'user'", () => {
    const out = collapseByTriggerSource([
      {
        triggered_by: "weird_future_value",
        model: "claude-sonnet-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.triggeredBy).toBe("user");
  });

  it("returns empty array for empty input", () => {
    expect(collapseByTriggerSource([])).toEqual([]);
  });
});

describe("collapseByUser", () => {
  it("groups rows by user_id and preserves user metadata", () => {
    const out = collapseByUser([
      {
        user_id: "u1",
        user_name: "Alice",
        user_email: "alice@example.com",
        model: "claude-sonnet-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
      {
        user_id: "u1",
        user_name: "Alice",
        user_email: "alice@example.com",
        model: "claude-haiku-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
      {
        user_id: "u2",
        user_name: "Bob",
        user_email: "bob@example.com",
        model: "claude-sonnet-4-5",
        input_tokens: "0",
        output_tokens: String(M),
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
    ]);

    // u2 spent more ($15 vs $4) so sorts first.
    expect(out.map((r) => r.userId)).toEqual(["u2", "u1"]);
    expect(out[0]!.userName).toBe("Bob");
    expect(out[0]!.userEmail).toBe("bob@example.com");
    expect(out[0]!.costUsdEstimate).toBeCloseTo(15, 6);
    // u1 has 1M sonnet input ($3) + 1M haiku input ($1) = $4.
    expect(out[1]!.costUsdEstimate).toBeCloseTo(4, 6);
    expect(out[1]!.inputTokens).toBe(2 * M);
  });

  it("preserves null name/email for deleted user rows (LEFT JOIN miss)", () => {
    const out = collapseByUser([
      {
        user_id: "u-deleted",
        user_name: null,
        user_email: null,
        model: "claude-sonnet-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("u-deleted");
    expect(out[0]!.userName).toBeNull();
    expect(out[0]!.userEmail).toBeNull();
  });
});

describe("collapseByDayByTriggerSource", () => {
  it("groups by (day, trigger_by) and orders chronologically", () => {
    const out = collapseByDayByTriggerSource([
      {
        day: "2026-04-01",
        triggered_by: "user",
        model: "claude-sonnet-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
      {
        day: "2026-04-01",
        triggered_by: "scheduler",
        model: "claude-haiku-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
      {
        day: "2026-04-02",
        triggered_by: "user",
        model: "claude-sonnet-4-5",
        input_tokens: String(M),
        output_tokens: String(M),
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
    ]);

    // Chronological day, then alphabetical triggered_by.
    expect(out.map((r) => `${r.day}|${r.triggeredBy}`)).toEqual([
      "2026-04-01|scheduler",
      "2026-04-01|user",
      "2026-04-02|user",
    ]);
    // Apr 2 user: 1M sonnet input + 1M sonnet output = $3 + $15 = $18.
    const apr2 = out.find(
      (r) => r.day === "2026-04-02" && r.triggeredBy === "user",
    )!;
    expect(apr2.costUsdEstimate).toBeCloseTo(18, 6);
  });

  it("collapses multiple model rows on the same (day, trigger) bucket", () => {
    const out = collapseByDayByTriggerSource([
      {
        day: "2026-04-01",
        triggered_by: "user",
        model: "claude-sonnet-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
      {
        day: "2026-04-01",
        triggered_by: "user",
        model: "claude-haiku-4-5",
        input_tokens: String(M),
        output_tokens: "0",
        cache_creation_input_tokens: "0",
        cache_read_input_tokens: "0",
      },
    ]);
    expect(out).toHaveLength(1);
    // 1M sonnet input ($3) + 1M haiku input ($1) = $4.
    expect(out[0]!.costUsdEstimate).toBeCloseTo(4, 6);
    expect(out[0]!.inputTokens).toBe(2 * M);
  });
});
