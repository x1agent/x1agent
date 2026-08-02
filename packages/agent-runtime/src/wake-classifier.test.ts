import { describe, it, expect } from "bun:test";
import {
  buildAgentThinkingCancelledEvent,
  buildAgentThinkingEvent,
  classifyWakeSource,
  TRANSIENT_EVENT_TYPES,
} from "./wake-classifier.js";

describe("classifyWakeSource", () => {
  it("defaults to 'user' on a bare envelope", () => {
    expect(classifyWakeSource({})).toBe("user");
  });

  it("derives share_comment from kind=comment_added", () => {
    expect(classifyWakeSource({ kind: "comment_added" })).toBe("share_comment");
  });

  it("derives share_comment from kind=comment_resolved", () => {
    expect(classifyWakeSource({ kind: "comment_resolved" })).toBe(
      "share_comment",
    );
  });

  it("derives scheduler from kind=heartbeat", () => {
    expect(classifyWakeSource({ kind: "heartbeat" })).toBe("scheduler");
  });

  it("derives platform from kind=state_change/watchdog/checkup", () => {
    expect(classifyWakeSource({ kind: "state_change" })).toBe("platform");
    expect(classifyWakeSource({ kind: "watchdog" })).toBe("platform");
    expect(classifyWakeSource({ kind: "checkup" })).toBe("platform");
  });

  it("derives child_message from kind=message", () => {
    expect(classifyWakeSource({ kind: "message" })).toBe("child_message");
  });

  it("explicit wake_source wins over derivation", () => {
    expect(
      classifyWakeSource({ wake_source: "platform", kind: "comment_added" }),
    ).toBe("platform");
  });

  it("ignores invalid wake_source and falls back to derivation", () => {
    // Don't trust attacker-controlled fields blindly — the kind/source
    // derivation rules are the authoritative classifier.
    expect(
      classifyWakeSource({ wake_source: "evil-string", kind: "heartbeat" }),
    ).toBe("scheduler");
  });
});

describe("buildAgentThinkingEvent", () => {
  it("user wake produces share_id=null, thread_id=null, fresh event_id", () => {
    const ev = buildAgentThinkingEvent("sess-1", {});
    expect(ev.type).toBe("session.agent_thinking");
    expect(ev.session_id).toBe("sess-1");
    expect(ev.share_id).toBeNull();
    expect(ev.thread_id).toBeNull();
    expect(ev.wake_source).toBe("user");
    expect(typeof ev.event_id).toBe("string");
    expect(ev.event_id.length).toBeGreaterThan(20);
    expect(typeof ev.started_at).toBe("string");
  });

  it("uses upstream event_id when provided (correlation contract)", () => {
    const ev = buildAgentThinkingEvent("sess-1", {
      event_id: "browser-abc-123",
    });
    expect(ev.event_id).toBe("browser-abc-123");
  });

  it("share_comment wake carries share_id + thread_id", () => {
    const ev = buildAgentThinkingEvent("sess-1", {
      kind: "comment_added",
      share_id: "share-xyz",
      thread_id: "thread-abc",
      event_id: "comment-1",
    });
    expect(ev.wake_source).toBe("share_comment");
    expect(ev.share_id).toBe("share-xyz");
    expect(ev.thread_id).toBe("thread-abc");
    expect(ev.event_id).toBe("comment-1");
  });

  it("share_id/thread_id are nulled when not a share_comment wake", () => {
    // Don't leak share scope from an unrelated wake just because the
    // envelope had a share_id field set by a buggy publisher.
    const ev = buildAgentThinkingEvent("sess-1", {
      kind: "heartbeat",
      share_id: "share-xyz",
      thread_id: "thread-abc",
    });
    expect(ev.wake_source).toBe("scheduler");
    expect(ev.share_id).toBeNull();
    expect(ev.thread_id).toBeNull();
  });

  it("share_comment with only one of share_id/thread_id produces both null", () => {
    // The spec is explicit: both set, or both null.
    const ev = buildAgentThinkingEvent("sess-1", {
      kind: "comment_added",
      share_id: "share-xyz",
      thread_id: null,
    });
    expect(ev.share_id).toBeNull();
    expect(ev.thread_id).toBeNull();
  });

  it("started_at is ISO 8601", () => {
    const fixed = new Date("2026-05-13T10:00:00.000Z");
    const ev = buildAgentThinkingEvent("sess-1", {}, fixed);
    expect(ev.started_at).toBe("2026-05-13T10:00:00.000Z");
  });

  it("scheduler / platform / child_message wakes per locked mapping", () => {
    expect(
      buildAgentThinkingEvent("s", { kind: "heartbeat" }).wake_source,
    ).toBe("scheduler");
    expect(
      buildAgentThinkingEvent("s", { kind: "state_change" }).wake_source,
    ).toBe("platform");
    expect(buildAgentThinkingEvent("s", { kind: "watchdog" }).wake_source).toBe(
      "platform",
    );
    expect(buildAgentThinkingEvent("s", { kind: "checkup" }).wake_source).toBe(
      "platform",
    );
    expect(buildAgentThinkingEvent("s", { kind: "message" }).wake_source).toBe(
      "child_message",
    );
  });
});

describe("buildAgentThinkingCancelledEvent", () => {
  it("produces a payload that ties back to the originating event_id", () => {
    const ev = buildAgentThinkingCancelledEvent(
      "sess-1",
      "evt-42",
      "graceful_shutdown",
    );
    expect(ev).toEqual({
      type: "session.agent_thinking_cancelled",
      session_id: "sess-1",
      event_id: "evt-42",
      reason: "graceful_shutdown",
    });
  });
});

describe("TRANSIENT_EVENT_TYPES", () => {
  it("lists exactly the two transient types so the api skip-list stays in sync", () => {
    expect(TRANSIENT_EVENT_TYPES.has("session.agent_thinking")).toBe(true);
    expect(TRANSIENT_EVENT_TYPES.has("session.agent_thinking_cancelled")).toBe(
      true,
    );
    expect(TRANSIENT_EVENT_TYPES.size).toBe(2);
  });
});
