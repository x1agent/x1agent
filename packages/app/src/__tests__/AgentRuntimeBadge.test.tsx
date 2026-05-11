import { describe, it, expect } from "bun:test";
import { renderToString } from "react-dom/server";
import type { SessionStatus } from "@x1agent/shared";
import {
  AgentRuntimeBadge,
  deriveAgentRuntimeState,
} from "../features/agents/AgentRuntimeBadge";

const sessions = (...statuses: SessionStatus[]) =>
  statuses.map((status) => ({ status }));

describe("deriveAgentRuntimeState", () => {
  it('returns "running" when at least one session is in running state', () => {
    expect(
      deriveAgentRuntimeState(true, sessions("complete", "running", "failed")),
    ).toBe("running");
  });

  it('returns "running" even when the schedule is off, if a session is live', () => {
    // Runtime activity wins over schedule state — a paused agent that
    // still has a live session is doing something, so reading "paused"
    // would mislead the operator.
    expect(deriveAgentRuntimeState(false, sessions("running"))).toBe("running");
  });

  it('returns "idle" when the schedule is on but nothing is running', () => {
    expect(
      deriveAgentRuntimeState(true, sessions("complete", "failed", "pending")),
    ).toBe("idle");
  });

  it('returns "idle" when the schedule is on and there are no sessions at all', () => {
    expect(deriveAgentRuntimeState(true, [])).toBe("idle");
  });

  it('returns "paused" when the schedule is off and nothing is running', () => {
    expect(deriveAgentRuntimeState(false, sessions("complete", "failed"))).toBe(
      "paused",
    );
  });

  it('returns "paused" when the schedule is off and there are no sessions at all', () => {
    expect(deriveAgentRuntimeState(false, [])).toBe("paused");
  });
});

describe("AgentRuntimeBadge", () => {
  it("renders the running label and success styling for a live agent", () => {
    const html = renderToString(
      <AgentRuntimeBadge isActive={true} sessions={sessions("running")} />,
    );
    expect(html).toContain("running");
    // success variant — the green ring class is part of the badge
    // styling. Stable enough to assert on without coupling to the
    // full class string.
    expect(html).toContain("emerald");
  });

  it("renders the idle label and secondary styling when the schedule is on but nothing is live", () => {
    const html = renderToString(
      <AgentRuntimeBadge isActive={true} sessions={[]} />,
    );
    expect(html).toContain("idle");
    expect(html).toContain("bg-bg-muted");
  });

  it("renders the paused label and outline styling when the schedule is off", () => {
    const html = renderToString(
      <AgentRuntimeBadge isActive={false} sessions={[]} />,
    );
    expect(html).toContain("paused");
    expect(html).toContain("border-border-soft");
  });
});
