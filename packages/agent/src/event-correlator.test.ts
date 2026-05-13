import { describe, it, expect } from "bun:test";
import { createEventCorrelator, isStampable } from "./event-correlator.js";

describe("isStampable", () => {
  it("agent.* emissions are stampable", () => {
    expect(isStampable("agent.text")).toBe(true);
    expect(isStampable("agent.tool_call")).toBe(true);
    expect(isStampable("agent.tool_result")).toBe(true);
    expect(isStampable("agent.thinking")).toBe(true);
  });

  it("session.completed / session.failed are stampable (terminal answer)", () => {
    expect(isStampable("session.completed")).toBe(true);
    expect(isStampable("session.failed")).toBe(true);
  });

  it("user.* echoes are NOT stampable (those are wakes, not replies)", () => {
    expect(isStampable("user.message")).toBe(false);
    expect(isStampable("user.input_response")).toBe(false);
  });

  it("transient indicator types are NOT stampable (carry event_id natively)", () => {
    expect(isStampable("session.agent_thinking")).toBe(false);
    expect(isStampable("session.agent_thinking_cancelled")).toBe(false);
  });

  it("session lifecycle non-terminal events are NOT stampable", () => {
    expect(isStampable("session.started")).toBe(false);
    expect(isStampable("session.init")).toBe(false);
  });
});

describe("createEventCorrelator", () => {
  it("starts with no pending id", () => {
    const c = createEventCorrelator();
    expect(c.pending()).toBeNull();
  });

  it("arm() sets the id; clear() unsets it", () => {
    const c = createEventCorrelator();
    c.arm("evt-1");
    expect(c.pending()).toBe("evt-1");
    c.clear();
    expect(c.pending()).toBeNull();
  });

  it("only the first stampable emission consumes the armed id", () => {
    const c = createEventCorrelator();
    c.arm("evt-7");
    const first = { type: "agent.text", payload: { text: "hi" } };
    const second = { type: "agent.text", payload: { text: "more" } };

    expect(c.maybeStamp(first)).toBe(true);
    expect((first.payload as Record<string, unknown>).event_id).toBe("evt-7");
    expect(c.pending()).toBeNull();

    // Subsequent stampable events in the same turn don't get re-stamped.
    expect(c.maybeStamp(second)).toBe(false);
    expect(
      (second.payload as Record<string, unknown>).event_id,
    ).toBeUndefined();
  });

  it("non-stampable events do NOT consume the armed id", () => {
    const c = createEventCorrelator();
    c.arm("evt-2");
    // user echo first; the indicator's event_id should still wait for
    // the agent's reply.
    expect(c.maybeStamp({ type: "user.message", payload: { text: "hi" } })).toBe(
      false,
    );
    expect(c.pending()).toBe("evt-2");
    // Then the agent answers — that gets stamped.
    const reply = { type: "agent.text", payload: { text: "yo" } };
    expect(c.maybeStamp(reply)).toBe(true);
    expect((reply.payload as Record<string, unknown>).event_id).toBe("evt-2");
  });

  it("a second arm() supersedes the first (frontend TTL handles the orphan)", () => {
    const c = createEventCorrelator();
    c.arm("evt-A");
    c.arm("evt-B");
    expect(c.pending()).toBe("evt-B");
    const ev = { type: "agent.text", payload: { text: "x" } };
    c.maybeStamp(ev);
    expect((ev.payload as Record<string, unknown>).event_id).toBe("evt-B");
  });

  it("does not stamp primitive payloads (avoids reshaping non-object events)", () => {
    const c = createEventCorrelator();
    c.arm("evt-3");
    const ev = { type: "agent.text", payload: "raw string" };
    expect(c.maybeStamp(ev)).toBe(false);
    expect(c.pending()).toBe("evt-3"); // still armed
  });

  it("does not stamp array payloads either", () => {
    const c = createEventCorrelator();
    c.arm("evt-4");
    const ev = { type: "agent.text", payload: [1, 2] };
    expect(c.maybeStamp(ev)).toBe(false);
    expect(c.pending()).toBe("evt-4");
  });

  it("nothing to stamp when nothing is armed", () => {
    const c = createEventCorrelator();
    const ev = { type: "agent.text", payload: { text: "x" } };
    expect(c.maybeStamp(ev)).toBe(false);
    expect((ev.payload as Record<string, unknown>).event_id).toBeUndefined();
  });
});
