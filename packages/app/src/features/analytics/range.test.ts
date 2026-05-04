import { describe, it, expect } from "bun:test";
import { presetToRange, priorRange } from "./range.js";

// Mid-week so "thisWeek" computation is non-trivial.
const NOW = new Date("2026-04-15T17:30:00Z"); // Wednesday

describe("presetToRange", () => {
  it("today is [today, tomorrow)", () => {
    expect(presetToRange("today", NOW)).toEqual({
      since: "2026-04-15",
      until: "2026-04-16",
    });
  });

  it("yesterday is [yesterday, today)", () => {
    expect(presetToRange("yesterday", NOW)).toEqual({
      since: "2026-04-14",
      until: "2026-04-15",
    });
  });

  it("thisWeek anchors to Monday and ends at tomorrow exclusive", () => {
    // Wed 2026-04-15 → Monday 2026-04-13.
    expect(presetToRange("thisWeek", NOW)).toEqual({
      since: "2026-04-13",
      until: "2026-04-16",
    });
  });

  it("thisWeek on Monday is just [today, tomorrow)", () => {
    const monday = new Date("2026-04-13T00:00:00Z");
    expect(presetToRange("thisWeek", monday)).toEqual({
      since: "2026-04-13",
      until: "2026-04-14",
    });
  });

  it("thisWeek on Sunday treats Monday as the start, not Sunday", () => {
    const sunday = new Date("2026-04-19T12:00:00Z");
    expect(presetToRange("thisWeek", sunday)).toEqual({
      since: "2026-04-13",
      until: "2026-04-20",
    });
  });

  it("thisMonth runs from the 1st of the month to tomorrow exclusive", () => {
    expect(presetToRange("thisMonth", NOW)).toEqual({
      since: "2026-04-01",
      until: "2026-04-16",
    });
  });

  it("last30d is a 30-day window ending tomorrow", () => {
    expect(presetToRange("last30d", NOW)).toEqual({
      since: "2026-03-17",
      until: "2026-04-16",
    });
  });

  it("last90d is a 90-day window ending tomorrow", () => {
    expect(presetToRange("last90d", NOW)).toEqual({
      since: "2026-01-16",
      until: "2026-04-16",
    });
  });

  it("custom uses provided dates when both set", () => {
    expect(
      presetToRange("custom", NOW, { since: "2025-12-01", until: "2026-01-01" }),
    ).toEqual({ since: "2025-12-01", until: "2026-01-01" });
  });

  it("custom with missing dates degrades to thisMonth", () => {
    expect(
      presetToRange("custom", NOW, { since: null, until: null }),
    ).toEqual(presetToRange("thisMonth", NOW));
    expect(
      presetToRange("custom", NOW, { since: "2025-12-01", until: null }),
    ).toEqual(presetToRange("thisMonth", NOW));
  });

  it("crosses month boundaries cleanly", () => {
    // April 1 — thisMonth should be just [Apr 1, Apr 2).
    const apr1 = new Date("2026-04-01T08:00:00Z");
    expect(presetToRange("thisMonth", apr1)).toEqual({
      since: "2026-04-01",
      until: "2026-04-02",
    });
    // last30d crosses March/April.
    expect(presetToRange("last30d", apr1)).toEqual({
      since: "2026-03-03",
      until: "2026-04-02",
    });
  });
});

describe("priorRange", () => {
  // NOW = Wed 2026-04-15, mid-week.
  const NOW = new Date("2026-04-15T17:30:00Z");

  it("today → yesterday", () => {
    expect(priorRange("today", NOW)).toEqual({
      since: "2026-04-14",
      until: "2026-04-15",
    });
  });

  it("yesterday → day before yesterday", () => {
    expect(priorRange("yesterday", NOW)).toEqual({
      since: "2026-04-13",
      until: "2026-04-14",
    });
  });

  it("thisWeek → previous full Monday-Sunday week", () => {
    expect(priorRange("thisWeek", NOW)).toEqual({
      since: "2026-04-06",
      until: "2026-04-13",
    });
  });

  it("thisMonth → previous full month", () => {
    expect(priorRange("thisMonth", NOW)).toEqual({
      since: "2026-03-01",
      until: "2026-04-01",
    });
  });

  it("last30d → 30 days before the current window", () => {
    expect(priorRange("last30d", NOW)).toEqual({
      since: "2026-02-15",
      until: "2026-03-17",
    });
  });

  it("last90d → 90 days before the current window", () => {
    expect(priorRange("last90d", NOW)).toEqual({
      since: "2025-10-18",
      until: "2026-01-16",
    });
  });

  it("custom range mirrors equal-length window immediately before since", () => {
    // 31-day current → 31-day prior right before it.
    expect(
      priorRange("custom", NOW, { since: "2026-03-01", until: "2026-04-01" }),
    ).toEqual({ since: "2026-01-29", until: "2026-03-01" });
  });
});
