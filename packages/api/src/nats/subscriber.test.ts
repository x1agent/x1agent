import { describe, it, expect } from "bun:test";
import {
  TRANSIENT_EVENT_TYPES,
  deriveWakeKindFromText,
  enrichWakePayload,
} from "./subscriber.js";

/**
 * X1A-103 — the api's NATS subscriber must drop transient indicator
 * events on the floor instead of persisting them. The "skip" logic is
 * just a Set lookup; this test pins the Set membership so a future
 * refactor that adds a new transient type without updating the
 * skip-list breaks here, not in production.
 */
describe("TRANSIENT_EVENT_TYPES", () => {
  it("contains exactly the two X1A-103 transient event types", () => {
    expect(TRANSIENT_EVENT_TYPES.has("session.agent_thinking")).toBe(true);
    expect(TRANSIENT_EVENT_TYPES.has("session.agent_thinking_cancelled")).toBe(
      true,
    );
    expect(TRANSIENT_EVENT_TYPES.size).toBe(2);
  });

  it("does NOT contain durable event types — guards against an over-broad skip-list", () => {
    expect(TRANSIENT_EVENT_TYPES.has("agent.text")).toBe(false);
    expect(TRANSIENT_EVENT_TYPES.has("agent.tool_call")).toBe(false);
    expect(TRANSIENT_EVENT_TYPES.has("user.message")).toBe(false);
    expect(TRANSIENT_EVENT_TYPES.has("session.started")).toBe(false);
    expect(TRANSIENT_EVENT_TYPES.has("session.completed")).toBe(false);
  });
});

describe("deriveWakeKindFromText", () => {
  it("recognises the five wake header literals", () => {
    expect(deriveWakeKindFromText("[driverless wake: watchdog — child silent]")).toBe(
      "watchdog",
    );
    expect(deriveWakeKindFromText("[driverless wake: scheduler heartbeat]")).toBe(
      "heartbeat",
    );
    expect(deriveWakeKindFromText("[driverless wake: platform checkup]")).toBe(
      "checkup",
    );
    expect(
      deriveWakeKindFromText("[driverless wake: message from child agent-x]"),
    ).toBe("message");
    expect(
      deriveWakeKindFromText("[driverless wake: child finished]"),
    ).toBe("state_change");
  });

  it("returns null for non-wake text (a normal user message)", () => {
    expect(deriveWakeKindFromText("hi there")).toBeNull();
  });
});

describe("enrichWakePayload", () => {
  it("user.message text without a wake header is left untouched", () => {
    const out = enrichWakePayload("user.message", { text: "hello" });
    expect(out.text).toBe("hello");
    expect(out.kind).toBeUndefined();
    expect(out.source).toBeUndefined();
  });

  it("user.message text with a wake header gets kind/source/driverless fields filled", () => {
    const out = enrichWakePayload("user.message", {
      text: "[driverless wake: scheduler heartbeat]\n\nrun a checkup",
    });
    expect(out.kind).toBe("heartbeat");
    expect(out.source).toBe("platform");
    expect(out.driverless).toBe(true);
  });

  it("non-user.message types pass through unchanged", () => {
    const out = enrichWakePayload("agent.text", { text: "hi" });
    expect(out.text).toBe("hi");
  });
});
