import { describe, it, expect } from "bun:test";
import { FixedClock, systemClock } from "./clock.js";

describe("FixedClock", () => {
  it("returns the configured time", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    const clock = new FixedClock(t);
    expect(clock.now().getTime()).toBe(t.getTime());
  });

  it("advances by the given millis", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("resets to an exact time via set()", () => {
    const clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));
    clock.set(new Date("2030-06-15T12:00:00Z"));
    expect(clock.now().toISOString()).toBe("2030-06-15T12:00:00.000Z");
  });
});

describe("systemClock", () => {
  it("returns a time close to Date.now()", () => {
    const before = Date.now();
    const t = systemClock.now().getTime();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
