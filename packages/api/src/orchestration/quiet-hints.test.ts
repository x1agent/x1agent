import { describe, it, expect } from "bun:test";
import { QuietHintStore } from "./quiet-hints.js";

describe("QuietHintStore", () => {
  it("records a hint and marks the session quiet until it expires", () => {
    const store = new QuietHintStore();
    const now = new Date("2026-04-23T12:00:00Z");
    store.record("s1", 600, "npm install", now);
    expect(store.isQuiet("s1", now)).toBe(true);
    const before = new Date(now.getTime() + 599 * 1000);
    expect(store.isQuiet("s1", before)).toBe(true);
    const after = new Date(now.getTime() + 601 * 1000);
    expect(store.isQuiet("s1", after)).toBe(false);
  });

  it("clears the hint when it expires on access", () => {
    const store = new QuietHintStore();
    store.record("s1", 1, null);
    expect(store.activeCount()).toBe(1);
    const after = new Date(Date.now() + 2000);
    expect(store.isQuiet("s1", after)).toBe(false);
    expect(store.activeCount()).toBe(0);
  });

  it("returns false for a session that has no hint", () => {
    const store = new QuietHintStore();
    expect(store.isQuiet("never-set")).toBe(false);
  });

  it("overwrites instead of stacking when the same session extends", () => {
    const store = new QuietHintStore();
    store.record("s1", 100, "short task");
    store.record("s1", 1000, "longer task");
    expect(store.activeCount()).toBe(1);
    const in500s = new Date(Date.now() + 500 * 1000);
    expect(store.isQuiet("s1", in500s)).toBe(true);
  });

  it("zero or negative seconds clears the hint", () => {
    const store = new QuietHintStore();
    store.record("s1", 100, "work");
    expect(store.activeCount()).toBe(1);
    store.record("s1", 0, null);
    expect(store.activeCount()).toBe(0);
    store.record("s1", 100, "work");
    store.record("s1", -5, null);
    expect(store.activeCount()).toBe(0);
  });
});
