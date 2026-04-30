import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import { CronSchedule } from "./cron-schedule.js";
import { AgentKind, isOrchestratorKind } from "./kind.js";
import { RuntimeType } from "./runtime.js";

describe("CronSchedule", () => {
  it.each([
    "@hourly",
    "@daily",
    "@weekly",
    "@every 5m",
    "@every 30m",
    "@every 2h",
    "@every 1d",
    "0 * * * *",
    "*/15 * * * *",
    "0 9 * * mon-fri",
  ])("accepts %p", (s) => {
    expect(CronSchedule(s)).toBe(s as ReturnType<typeof CronSchedule>);
  });

  it.each([
    "",
    "   ",
    "@sometimes",
    "@every 10 seconds",
    "0 * * *", // only 4 fields
    "0 * * * * *", // 6 fields
    "!!! * * * *",
  ])("rejects %p", (s) => {
    expect(() => CronSchedule(s)).toThrow(ValidationError);
  });
});

describe("RuntimeType", () => {
  it("accepts claude_code", () => {
    expect(RuntimeType("claude_code")).toBe("claude_code");
  });

  it("rejects unknown runtimes", () => {
    expect(() => RuntimeType("lobotomized_claude")).toThrow(ValidationError);
  });
});

describe("AgentKind", () => {
  it.each(["worker", "orchestrator", "scheduled"])("accepts %p", (k) => {
    expect(AgentKind(k)).toBe(k as ReturnType<typeof AgentKind>);
  });

  it.each([
    "",
    "WORKER",
    "Orchestrator",
    "agent",
    "human",
    "worker ",
    " worker",
  ])("rejects %p", (k) => {
    expect(() => AgentKind(k)).toThrow(ValidationError);
  });

  it("isOrchestratorKind is true only for 'orchestrator'", () => {
    expect(isOrchestratorKind(AgentKind("orchestrator"))).toBe(true);
    expect(isOrchestratorKind(AgentKind("worker"))).toBe(false);
    expect(isOrchestratorKind(AgentKind("scheduled"))).toBe(false);
  });
});
