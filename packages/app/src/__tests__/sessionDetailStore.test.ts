import { describe, it, expect, beforeEach } from "bun:test";
import type { SessionEventDTO } from "@x1agent/shared";
import { useSessionDetailStore } from "../stores/sessionDetailStore";

const SID = "test-session";

function ev(type: string, seq: number): SessionEventDTO {
  return {
    id: String(seq),
    session_id: SID,
    seq,
    type,
    payload: {},
    timestamp: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  useSessionDetailStore.setState({
    sessionsById: {},
    agentsBySession: {},
    parentBySession: {},
    childrenBySession: {},
    eventsBySession: {},
    compactItemsBySession: {},
    statusBySession: {},
    errorBySession: {},
  });
});

describe("sessionDetailStore.compactItemsBySession", () => {
  it("derives compact rows from appended events", () => {
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("session.started", 1));
    appendEvent(SID, ev("agent.status", 2));
    appendEvent(SID, ev("agent.status", 3));
    appendEvent(SID, ev("agent.tool_call", 4));
    appendEvent(SID, ev("agent.tool_call", 5));
    appendEvent(SID, ev("agent.text", 6));

    const items = useSessionDetailStore.getState().compactItemsBySession[SID];
    expect(items).toBeDefined();
    expect(items!.map((i) => i.kind)).toEqual([
      "event",
      "status",
      "tools",
      "event",
    ]);
    const statusItem = items![1];
    if (statusItem?.kind !== "status") throw new Error("expected status row");
    expect(statusItem.latest.seq).toBe(3);
    const toolsItem = items![2];
    if (toolsItem?.kind !== "tools") throw new Error("expected tools row");
    expect(toolsItem.events.map((e) => e.seq)).toEqual([4, 5]);
  });

  it("hides internal types in the compact rows", () => {
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("session.init", 1));
    appendEvent(SID, ev("agent.tool_result", 2));
    appendEvent(SID, ev("agent.text", 3));

    const items = useSessionDetailStore.getState().compactItemsBySession[SID];
    expect(items!.map((i) => i.kind)).toEqual(["event"]);
    const only = items![0];
    if (only?.kind !== "event") throw new Error("expected event row");
    expect(only.event.seq).toBe(3);
  });

  it("returns the same compactItems reference when an event is deduplicated", () => {
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("agent.text", 1));
    const before =
      useSessionDetailStore.getState().compactItemsBySession[SID];
    // Same (seq, type) tuple → dedup short-circuit; nothing should change.
    appendEvent(SID, ev("agent.text", 1));
    const after = useSessionDetailStore.getState().compactItemsBySession[SID];
    expect(after).toBe(before);
  });

  it("produces a fresh array reference when a new event is appended", () => {
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("agent.text", 1));
    const before =
      useSessionDetailStore.getState().compactItemsBySession[SID];
    appendEvent(SID, ev("agent.text", 2));
    const after = useSessionDetailStore.getState().compactItemsBySession[SID];
    expect(after).not.toBe(before);
    expect(after!.length).toBe(2);
  });
});
