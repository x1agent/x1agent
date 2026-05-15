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

describe("sessionDetailStore status transitions (X1A-66)", () => {
  function seedPendingSession() {
    useSessionDetailStore.setState({
      sessionsById: {
        [SID]: {
          id: SID,
          agent_id: "agent-a",
          triggered_by: "user",
          triggered_by_user_id: "user-1",
          parent_session_id: null,
          parent_agent_id: null,
          resumed_from: null,
          triggered_at: "2026-01-01T00:00:00Z",
          status: "pending",
          completed_at: null,
          error_message: null,
          created_at: "2026-01-01T00:00:00Z",
          summary: null,
          summary_event_seq: null,
          summary_started_at: null,
          summary_failed_at: null,
          model_override: null,
        } as never,
      },
    });
  }

  it("flips status from pending to running when session.started arrives", () => {
    seedPendingSession();
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("session.started", 1));
    const session =
      useSessionDetailStore.getState().sessionsById[SID];
    expect(session!.status).toBe("running");
  });

  it("does not change status when session.started arrives on a non-pending session", () => {
    seedPendingSession();
    // Pre-set to running — a second session.started (e.g. from a
    // pod-restart event we haven't shipped yet) should NOT regress
    // the row back to running-from-something-else. Idempotent.
    useSessionDetailStore.setState((s) => ({
      sessionsById: {
        ...s.sessionsById,
        [SID]: { ...(s.sessionsById[SID] as never), status: "running" },
      },
    }));
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("session.started", 1));
    expect(
      useSessionDetailStore.getState().sessionsById[SID]!.status,
    ).toBe("running");
  });

  it("does not flip a terminal session back to running on a stale session.started", () => {
    seedPendingSession();
    useSessionDetailStore.setState((s) => ({
      sessionsById: {
        ...s.sessionsById,
        [SID]: { ...(s.sessionsById[SID] as never), status: "complete" },
      },
    }));
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("session.started", 1));
    expect(
      useSessionDetailStore.getState().sessionsById[SID]!.status,
    ).toBe("complete");
  });

  it("still flips to complete / failed on terminal events", () => {
    seedPendingSession();
    const { appendEvent } = useSessionDetailStore.getState();
    appendEvent(SID, ev("session.started", 1));
    appendEvent(SID, ev("session.completed", 2));
    expect(
      useSessionDetailStore.getState().sessionsById[SID]!.status,
    ).toBe("complete");
  });
});
