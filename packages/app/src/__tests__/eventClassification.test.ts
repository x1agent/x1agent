import { describe, it, expect } from "bun:test";
import type { SessionEventDTO } from "@x1agent/shared";
import {
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
