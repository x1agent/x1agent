import { describe, it, expect } from "bun:test";
import { _testing } from "./activity-watchdog.js";
import { formatWatchdogWakeText } from "./wake-publisher.js";

const { thresholdSecondsForAttempt, BACKOFF_MINUTES } = _testing;

describe("activity watchdog — backoff ladder", () => {
  it("attempt 1 → 5 minutes", () => {
    expect(thresholdSecondsForAttempt(1)).toBe(5 * 60);
  });

  it("attempt 2 → 10 minutes", () => {
    expect(thresholdSecondsForAttempt(2)).toBe(10 * 60);
  });

  it("attempt 3 → 20 minutes", () => {
    expect(thresholdSecondsForAttempt(3)).toBe(20 * 60);
  });

  it("attempt 4 → 40 minutes", () => {
    expect(thresholdSecondsForAttempt(4)).toBe(40 * 60);
  });

  it("attempt 5 → 60 minutes (cap)", () => {
    expect(thresholdSecondsForAttempt(5)).toBe(60 * 60);
  });

  it("attempt 10 → still capped at 60 minutes", () => {
    expect(thresholdSecondsForAttempt(10)).toBe(60 * 60);
  });

  it("attempt 0 or negative → clamped to first bucket (5 minutes)", () => {
    expect(thresholdSecondsForAttempt(0)).toBe(5 * 60);
    expect(thresholdSecondsForAttempt(-1)).toBe(5 * 60);
  });

  it("ladder matches the documented shape (5/10/20/40/60)", () => {
    expect([...BACKOFF_MINUTES]).toEqual([5, 10, 20, 40, 60]);
  });
});

describe("formatWatchdogWakeText", () => {
  it("first attempt reads as 'First watchdog tick on this child'", () => {
    const t = formatWatchdogWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "hirer-app",
      silenceSeconds: 5 * 60,
      attempt: 1,
    });
    expect(t).toContain("First watchdog tick on this child");
    expect(t).toContain("5 minutes");
    expect(t).toContain("hirer-app");
    expect(t).toContain("019d1111");
    expect(t).toContain("cancel_session");
    expect(t).toContain("post-mortem");
    expect(t).toContain("driverless");
  });

  it("subsequent attempts call out the escalating backoff", () => {
    const t = formatWatchdogWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "hirer-app",
      silenceSeconds: 20 * 60,
      attempt: 3,
    });
    expect(t).toContain("Watchdog attempt 3");
    expect(t).toContain("backoff still growing");
    expect(t).toContain("20 minutes");
  });

  it("silence duration is rendered in whole minutes (floor)", () => {
    const t = formatWatchdogWakeText({
      childSessionId: "019d1111-aaaa-7000-8000-000000000000",
      childSlug: "child",
      silenceSeconds: 329, // 5min 29s
      attempt: 1,
    });
    expect(t).toContain("5 minutes");
  });
});
