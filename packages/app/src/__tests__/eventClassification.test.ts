import { describe, it, expect } from "bun:test";
import type { SessionEventDTO } from "@x1agent/shared";
import {
  compactKind,
  compactTimeline,
  isPublicEventType,
  isShareCommentWakeEvent,
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

  it("agent.share with a repeated share_id replaces the original event at its slot", () => {
    // First share — v1 of the mockup at seq=1.
    const v1 = {
      ...ev("agent.share", 1),
      payload: { share_id: "s-abc", title: "X1A-59 mockup v1" },
    };
    // Two intervening events so the timeline has shape.
    const between = [ev("agent.text", 2), ev("agent.text", 3)];
    // v2 of the same mockup at seq=4 — same share_id.
    const v2 = {
      ...ev("agent.share", 4),
      payload: { share_id: "s-abc", title: "X1A-59 mockup v2" },
    };
    const items = compactTimeline([v1, ...between, v2]);
    // Three items: the share pill at slot 0 (unchanged position) plus
    // the two text events. The v2 event does NOT add a fourth slot.
    expect(items.length).toBe(3);
    if (items[0]!.kind !== "event")
      throw new Error("share pill should be an event item");
    // Latest payload wins.
    expect(items[0]!.event.seq).toBe(4);
    expect(
      (items[0]!.event.payload as { title: string }).title,
    ).toBe("X1A-59 mockup v2");
    // Key sticks to the v1 slot so React mutates the same subtree.
    expect(items[0]!.key).toBe("s1-1");
  });

  it("distinct share_ids each get their own slot — no cross-share collapse", () => {
    const a = {
      ...ev("agent.share", 1),
      payload: { share_id: "s-aaa", title: "A" },
    };
    const b = {
      ...ev("agent.share", 2),
      payload: { share_id: "s-bbb", title: "B" },
    };
    const items = compactTimeline([a, b]);
    expect(items.length).toBe(2);
    expect(items.map((i) => i.kind)).toEqual(["event", "event"]);
  });

  it("agent.share with no share_id falls through to default per-event rendering", () => {
    const a = { ...ev("agent.share", 1), payload: { title: "no id" } };
    const b = { ...ev("agent.share", 2), payload: { title: "still no id" } };
    const items = compactTimeline([a, b]);
    // Two distinct rows because there's no share_id to dedupe by.
    expect(items.length).toBe(2);
  });

  // ── X1A-110 — share-comment wakes ─────────────────────────────────
  it("drops share-comment-wake user.message rows from the timeline (Bug A)", () => {
    const human = { ...ev("user.message", 1), payload: { text: "hello" } };
    const wakeAdded = {
      ...ev("user.message", 2),
      payload: {
        text: "[wake: new comment on share abcd1234]\n...",
        kind: "comment_added",
        source: "platform",
        share_id: "share-1",
        thread_id: "thread-1",
        comment_id: "c1",
      },
    };
    const wakeResolved = {
      ...ev("user.message", 3),
      payload: {
        text: "[wake: comment thread resolved on share abcd1234]\n...",
        kind: "comment_resolved",
        source: "platform",
        share_id: "share-1",
        thread_id: "thread-1",
      },
    };
    const agentText = { ...ev("agent.text", 4), payload: { text: "ack" } };
    const items = compactTimeline([human, wakeAdded, wakeResolved, agentText]);
    // The human message + agent.text should survive; both wake rows
    // should be filtered out entirely — neither user-visible nor
    // counted in any compacted group.
    expect(items.length).toBe(2);
    if (items[0]!.kind !== "event") throw new Error("expected event");
    expect(items[0]!.event.seq).toBe(1);
    if (items[1]!.kind !== "event") throw new Error("expected event");
    expect(items[1]!.event.seq).toBe(4);
  });

  it("keeps a real user.message that happens to share a payload field name", () => {
    // Belt-and-braces: we filter on `kind`, NOT on body text. A real
    // human message with the word "comment" anywhere doesn't trip us.
    const human = {
      ...ev("user.message", 1),
      payload: { text: "I want to leave a comment somewhere" },
    };
    const items = compactTimeline([human]);
    expect(items.length).toBe(1);
  });
});

describe("isShareCommentWakeEvent", () => {
  it("matches payloads tagged with kind=comment_added", () => {
    expect(
      isShareCommentWakeEvent({
        kind: "comment_added",
        source: "platform",
      }),
    ).toBe(true);
  });

  it("matches payloads tagged with kind=comment_resolved", () => {
    expect(
      isShareCommentWakeEvent({
        kind: "comment_resolved",
        source: "platform",
      }),
    ).toBe(true);
  });

  it("does NOT match orchestration wakes (state_change, watchdog, …)", () => {
    expect(isShareCommentWakeEvent({ kind: "state_change" })).toBe(false);
    expect(isShareCommentWakeEvent({ kind: "watchdog" })).toBe(false);
    expect(isShareCommentWakeEvent({ kind: "heartbeat" })).toBe(false);
    expect(isShareCommentWakeEvent({ kind: "message" })).toBe(false);
  });

  it("does NOT match plain human messages (no kind)", () => {
    expect(isShareCommentWakeEvent({ text: "hi" })).toBe(false);
    expect(isShareCommentWakeEvent(null)).toBe(false);
    expect(isShareCommentWakeEvent(undefined)).toBe(false);
    expect(isShareCommentWakeEvent("plain string")).toBe(false);
  });
});
