import { describe, it, expect } from "bun:test";
import type { SessionEventDTO } from "@x1agent/shared";
import {
  compactKind,
  compactTimeline,
  isPublicEventType,
  latestPublicEvent,
} from "../features/sessions/eventClassification";

function ev(type: string, seq: number): SessionEventDTO {
  return {
    id: String(seq),
    session_id: "s1",
    seq,
    type,
    payload: {},
    timestamp: "2026-01-01T00:00:00Z",
  };
}

describe("isPublicEventType", () => {
  it("treats user/agent visible events as public", () => {
    for (const t of [
      "session.started",
      "session.completed",
      "session.failed",
      "session.resumed",
      "user.message",
      "user.input_response",
      "agent.text",
      "agent.status",
      "agent.artifact",
      "agent.share",
      "agent.input_request",
      "agent.permission_request",
      "agent.error",
    ]) {
      expect(isPublicEventType(t)).toBe(true);
    }
  });

  it("treats tool calls and other internals as not public", () => {
    for (const t of [
      "agent.tool_call",
      "agent.tool_result",
      "agent.tool_error",
      "agent.thinking",
      "session.init",
      "agent.unknown_future_type",
    ]) {
      expect(isPublicEventType(t)).toBe(false);
    }
  });
});

describe("latestPublicEvent", () => {
  it("returns the highest-seq public event, ignoring trailing internal events", () => {
    const events: SessionEventDTO[] = [
      ev("agent.status", 1),
      ev("agent.tool_call", 2),
      ev("agent.status", 3),
      ev("agent.tool_call", 4),
      ev("agent.tool_result", 5),
    ];
    const latest = latestPublicEvent(events);
    expect(latest?.seq).toBe(3);
  });

  it("returns null when no public events have arrived yet", () => {
    const events: SessionEventDTO[] = [
      ev("session.init", 1),
      ev("agent.tool_call", 2),
    ];
    expect(latestPublicEvent(events)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(latestPublicEvent([])).toBeNull();
  });
});

describe("compactKind", () => {
  it("classifies status as a status group", () => {
    expect(compactKind("agent.status")).toBe("status");
  });

  it("classifies tool calls as a tools group (not raw events)", () => {
    expect(compactKind("agent.tool_call")).toBe("tools");
  });

  it("classifies remaining public types as ordinary events", () => {
    expect(compactKind("agent.text")).toBe("event");
    expect(compactKind("user.message")).toBe("event");
    expect(compactKind("agent.share")).toBe("event");
    expect(compactKind("session.completed")).toBe("event");
  });

  it("classifies internals as hidden (compact mode skips them)", () => {
    expect(compactKind("agent.tool_result")).toBe("hidden");
    expect(compactKind("agent.tool_error")).toBe("hidden");
    expect(compactKind("agent.thinking")).toBe("hidden");
    expect(compactKind("session.init")).toBe("hidden");
    expect(compactKind("agent.future_unknown")).toBe("hidden");
  });
});

describe("compactTimeline", () => {
  it("returns an empty list for empty input", () => {
    expect(compactTimeline([])).toEqual([]);
  });

  it("drops hidden events entirely", () => {
    const events = [
      ev("session.init", 1),
      ev("agent.thinking", 2),
      ev("agent.tool_result", 3),
    ];
    expect(compactTimeline(events)).toEqual([]);
  });

  it("collapses a run of statuses into one row showing the LATEST", () => {
    const a = { ...ev("agent.status", 1), payload: { detail: "first" } };
    const b = { ...ev("agent.status", 2), payload: { detail: "second" } };
    const c = { ...ev("agent.status", 3), payload: { detail: "third" } };
    const items = compactTimeline([a, b, c]);
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe("status");
    if (items[0]!.kind !== "status") throw new Error("type guard");
    expect(items[0]!.latest.seq).toBe(3);
    // Stable key — anchored to the *first* status in the run so React
    // can mutate the same DOM node as new statuses arrive.
    expect(items[0]!.key).toBe("s1-1");
  });

  it("collapses a run of tool_calls into one tools group", () => {
    const items = compactTimeline([
      ev("agent.tool_call", 1),
      ev("agent.tool_call", 2),
      ev("agent.tool_call", 3),
      ev("agent.tool_call", 4),
    ]);
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe("tools");
    if (items[0]!.kind !== "tools") throw new Error("type guard");
    expect(items[0]!.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(items[0]!.key).toBe("s1-1");
  });

  it("preserves chronological order for mixed event/status/tools runs", () => {
    // Mirrors the screenshot scenario in X1A-41: ToolSearch (1 call),
    // then a status, then 4 tool calls, then text, then more tools.
    const events = [
      ev("agent.tool_call", 1),
      ev("agent.status", 2),
      ev("agent.tool_call", 3),
      ev("agent.tool_call", 4),
      ev("agent.tool_call", 5),
      ev("agent.tool_call", 6),
      ev("agent.text", 7),
      ev("agent.tool_call", 8),
      ev("agent.text", 9),
    ];
    const items = compactTimeline(events);
    const shapes = items.map((it) =>
      it.kind === "tools"
        ? `tools(${it.events.length})`
        : it.kind === "status"
          ? `status(${it.latest.seq})`
          : `event(${it.event.type},${it.event.seq})`,
    );
    expect(shapes).toEqual([
      "tools(1)",
      "status(2)",
      "tools(4)",
      "event(agent.text,7)",
      "tools(1)",
      "event(agent.text,9)",
    ]);
  });

  it("does not merge a tools group across an interrupting status", () => {
    const items = compactTimeline([
      ev("agent.tool_call", 1),
      ev("agent.status", 2),
      ev("agent.tool_call", 3),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tools", "status", "tools"]);
  });
});
