import { describe, expect, test, mock } from "bun:test";
import { createPeriodicScheduler } from "./periodic-scheduler.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("periodic-scheduler", () => {
  test("register before start, then runOnStart fires immediately", async () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    let calls = 0;
    sched.register({
      name: "kick",
      intervalMs: 10_000,
      runOnStart: true,
      fn: async () => {
        calls++;
      },
    });
    sched.start();
    await sleep(20);
    expect(calls).toBe(1);
    await sched.stop();
  });

  test("interval ticks repeatedly", async () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    let calls = 0;
    sched.register({
      name: "ticker",
      intervalMs: 30,
      fn: async () => {
        calls++;
      },
    });
    sched.start();
    await sleep(120);
    await sched.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("overlap guard drops a tick when prior tick is still running", async () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    let started = 0;
    sched.register({
      name: "slow",
      intervalMs: 10,
      runOnStart: true,
      fn: async () => {
        started++;
        await sleep(80);
      },
    });
    sched.start();
    await sleep(50);
    await sched.stop();
    // Without the overlap guard, ~5 ticks would have started by now.
    expect(started).toBe(1);
  });

  test("error in one task does not stop scheduler; Sentry captured", async () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    let goodCalls = 0;
    let badCalls = 0;
    sched.register({
      name: "bad",
      intervalMs: 30,
      runOnStart: true,
      fn: async () => {
        badCalls++;
        throw new Error("boom");
      },
    });
    sched.register({
      name: "good",
      intervalMs: 30,
      runOnStart: true,
      fn: async () => {
        goodCalls++;
      },
    });
    sched.start();
    await sleep(120);
    await sched.stop();
    expect(badCalls).toBeGreaterThanOrEqual(2);
    expect(goodCalls).toBeGreaterThanOrEqual(2);
  });

  test("stop() cancels future ticks", async () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    let calls = 0;
    sched.register({
      name: "stop-test",
      intervalMs: 20,
      runOnStart: true,
      fn: async () => {
        calls++;
      },
    });
    sched.start();
    await sleep(50);
    const callsAtStop = calls;
    await sched.stop();
    await sleep(100);
    expect(calls).toBe(callsAtStop);
  });

  test("register after start throws", () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    sched.register({ name: "first", intervalMs: 1000, fn: async () => {} });
    sched.start();
    expect(() =>
      sched.register({ name: "second", intervalMs: 1000, fn: async () => {} }),
    ).toThrow(/register.*after start/);
  });

  test("duplicate task name throws", () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    sched.register({ name: "dup", intervalMs: 1000, fn: async () => {} });
    expect(() =>
      sched.register({ name: "dup", intervalMs: 1000, fn: async () => {} }),
    ).toThrow(/duplicate/);
  });

  test("stop is idempotent", async () => {
    const sched = createPeriodicScheduler({ logger: () => {} });
    sched.register({ name: "x", intervalMs: 100, fn: async () => {} });
    sched.start();
    await sched.stop();
    await sched.stop();
  });

  test("structured log on slow tick", async () => {
    const lines: string[] = [];
    const sched = createPeriodicScheduler({
      logger: (s) => lines.push(s),
    });
    sched.register({
      name: "slow-log",
      intervalMs: 10,
      runOnStart: true,
      fn: async () => {
        await sleep(40);
      },
    });
    sched.start();
    await sleep(60);
    await sched.stop();
    expect(lines.some((l) => /task=slow-log/.test(l) && /ok/.test(l))).toBe(
      true,
    );
  });

  test("structured log on tick error", async () => {
    const lines: string[] = [];
    const sched = createPeriodicScheduler({
      logger: (s) => lines.push(s),
    });
    sched.register({
      name: "errlog",
      intervalMs: 10,
      runOnStart: true,
      fn: async () => {
        throw new Error("nope");
      },
    });
    sched.start();
    await sleep(40);
    await sched.stop();
    expect(
      lines.some((l) => /task=errlog/.test(l) && /err=nope/.test(l)),
    ).toBe(true);
  });
});
