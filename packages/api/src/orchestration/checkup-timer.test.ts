import { describe, it, expect } from "bun:test";
import {
  formatCheckupWakeText,
  type ChildSnapshot,
} from "./wake-publisher.js";

describe("formatCheckupWakeText", () => {
  it("empty snapshot — zero-child checkup prompt", () => {
    const t = formatCheckupWakeText([]);
    expect(t).toContain("no active children");
    expect(t).toContain("If there's work to do");
    expect(t).toContain("end the turn");
    expect(t).toContain("driverless");
  });

  it("one child — renders a one-line summary", () => {
    const t = formatCheckupWakeText([
      {
        sessionId: "019d1111-aaaa-7000-8000-000000000000",
        agentSlug: "hirer-app",
        status: "running",
        secondsSinceLastEvent: 42,
        lastStatus: "npm install in flight",
      },
    ]);
    expect(t).toContain("Active children (1)");
    expect(t).toContain("019d1111");
    expect(t).toContain("hirer-app");
    expect(t).toContain("running");
    expect(t).toContain("idle 0m");
    expect(t).toContain('"npm install in flight"');
  });

  it("multiple children — one line each, numbered correctly", () => {
    const children: ChildSnapshot[] = [
      {
        sessionId: "019d1111-aaaa-7000-8000-000000000000",
        agentSlug: "writer",
        status: "running",
        secondsSinceLastEvent: 120,
        lastStatus: "drafting",
      },
      {
        sessionId: "019d2222-bbbb-7000-8000-000000000000",
        agentSlug: "tester",
        status: "pending",
        secondsSinceLastEvent: 600,
        lastStatus: null,
      },
    ];
    const t = formatCheckupWakeText(children);
    expect(t).toContain("Active children (2)");
    expect(t).toContain("writer");
    expect(t).toContain("tester");
    expect(t).toContain("idle 2m");
    expect(t).toContain("idle 10m");
  });

  it("omits the status detail when last_status is null", () => {
    const t = formatCheckupWakeText([
      {
        sessionId: "019d1111-aaaa-7000-8000-000000000000",
        agentSlug: "agent",
        status: "running",
        secondsSinceLastEvent: 30,
        lastStatus: null,
      },
    ]);
    expect(t).not.toContain('""');
    expect(t).not.toContain(' — "');
  });

  it("includes governance guidance (read/cancel/end-turn)", () => {
    const t = formatCheckupWakeText([
      {
        sessionId: "019d1111-aaaa-7000-8000-000000000000",
        agentSlug: "agent",
        status: "running",
        secondsSinceLastEvent: 30,
        lastStatus: "working",
      },
    ]);
    expect(t).toContain("read_session");
    expect(t).toContain("cancel_session");
    expect(t).toContain("post-mortem");
    expect(t).toContain("end the turn");
  });
});
