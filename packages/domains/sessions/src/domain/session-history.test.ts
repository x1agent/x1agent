import { describe, expect, it } from "bun:test";
import { AgentId } from "@x1agent/domain-agents";
import { SessionId } from "./session.js";
import { SessionEventId } from "./event.js";
import type { Session } from "./session.js";
import type { SessionEvent } from "./event.js";
import {
  buildSessionHistory,
  formatEventsAsMarkdown,
  walkResumeChain,
  SESSION_RESUME_PROMPT,
} from "./session-history.js";

function mkSession(
  id: string,
  resumedFrom: string | null,
  triggeredAt = new Date("2026-04-20T10:00:00Z"),
): Session {
  return {
    id: SessionId(id),
    agentId: AgentId("00000000-0000-4000-8000-000000000001"),
    triggeredBy: "user",
    triggeredByUserId: null,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: resumedFrom ? SessionId(resumedFrom) : null,
    triggeredAt,
    status: "complete",
    completedAt: new Date(),
    errorMessage: null,
    createdAt: new Date(),
  };
}

function mkEvent(
  sessionId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: SessionEventId(`ev-${sessionId}-${seq}`),
    sessionId: SessionId(sessionId),
    seq,
    type,
    payload,
    timestamp: new Date("2026-04-20T10:01:00Z"),
    createdAt: new Date("2026-04-20T10:01:00Z"),
  };
}

describe("walkResumeChain", () => {
  it("returns just the origin when there is no chain", async () => {
    const origin = mkSession("s1", null);
    const chain = await walkResumeChain(origin, async () => null);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.id).toBe(SessionId("s1"));
  });

  it("walks back through multiple resumes, root-first", async () => {
    const s1 = mkSession("s1", null);
    const s2 = mkSession("s2", "s1");
    const s3 = mkSession("s3", "s2");
    const store = new Map([["s1", s1], ["s2", s2]]);
    const chain = await walkResumeChain(s3, async (id) => store.get(id) ?? null);
    expect(chain.map((s) => s.id as string)).toEqual(["s1", "s2", "s3"]);
  });

  it("stops safely on a cycle without looping", async () => {
    const s1 = mkSession("s1", "s2");
    const s2 = mkSession("s2", "s1");
    const store = new Map([["s1", s1], ["s2", s2]]);
    const chain = await walkResumeChain(s2, async (id) => store.get(id) ?? null);
    expect(chain.length).toBeLessThanOrEqual(2);
    expect(new Set(chain.map((s) => s.id)).size).toBe(chain.length);
  });

  it("short-circuits if a link in the chain is missing", async () => {
    const s2 = mkSession("s2", "missing");
    const chain = await walkResumeChain(s2, async () => null);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.id).toBe(SessionId("s2"));
  });
});

describe("formatEventsAsMarkdown", () => {
  it("renders user + agent messages and skips lifecycle noise", () => {
    const events: SessionEvent[] = [
      mkEvent("s1", 0, "session.started", {}),
      mkEvent("s1", 1, "user.message", { text: "hello" }),
      mkEvent("s1", 2, "agent.text", { text: "hi!" }),
      mkEvent("s1", 3, "session.completed", {}),
    ];
    const lines = formatEventsAsMarkdown(events);
    const joined = lines.join("\n");
    expect(joined).toContain("hello");
    expect(joined).toContain("hi!");
    expect(joined).not.toContain("session.started");
    expect(joined).not.toContain("session.completed");
  });

  it("formats artifacts with a code block", () => {
    const lines = formatEventsAsMarkdown([
      mkEvent("s1", 0, "agent.artifact", {
        title: "report",
        artifact_type: "markdown",
        content: "# hello",
      }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("**Artifact**");
    expect(joined).toContain("report");
    expect(joined).toContain("# hello");
  });
});

describe("buildSessionHistory", () => {
  it("returns empty string for an empty chain", () => {
    expect(
      buildSessionHistory([], new Map<SessionId, readonly SessionEvent[]>()),
    ).toBe("");
  });

  it("includes a header with the session count and each session's id", () => {
    const s1 = mkSession("s1", null);
    const s2 = mkSession("s2", "s1");
    const events = new Map<SessionId, readonly SessionEvent[]>([
      [SessionId("s1"), [mkEvent("s1", 1, "user.message", { text: "one" })]],
      [SessionId("s2"), [mkEvent("s2", 1, "user.message", { text: "two" })]],
    ]);
    const md = buildSessionHistory([s1, s2], events);
    expect(md).toContain("# Session History");
    expect(md).toContain("continuation of 2 prior sessions");
    expect(md).toContain("Session 1/2 — s1");
    expect(md).toContain("Session 2/2 — s2");
    expect(md).toContain("one");
    expect(md).toContain("two");
  });
});

describe("SESSION_RESUME_PROMPT", () => {
  it("points the agent at the mounted markdown file", () => {
    expect(SESSION_RESUME_PROMPT).toContain(
      "/workspace/session_history.md",
    );
  });
});
