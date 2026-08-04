import { describe, it, expect } from "bun:test";
import {
  TRANSIENT_EVENT_TYPES,
  deriveWakeKindFromText,
  enrichWakePayload,
  isShareCommentWakePayload,
  resolveRuntimeModelDefaultId,
} from "./subscriber";

describe("resolveRuntimeModelDefaultId", () => {
  const models = [
    { id: "default", resolvedModel: "claude-sonnet-4-6" },
    { id: "sonnet", resolvedModel: "claude-sonnet-4-6" },
    { id: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" },
  ];

  it("prefers the exact harness id when aliases resolve to the same model", () => {
    expect(resolveRuntimeModelDefaultId(models, "claude-sonnet-4-6")).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("selects only the first alias when the reported default is resolved-only", () => {
    const aliases = models.slice(0, 2);
    expect(resolveRuntimeModelDefaultId(aliases, "claude-sonnet-4-6")).toBe(
      "default",
    );
  });

  it("rejects an unknown reported default", () => {
    expect(resolveRuntimeModelDefaultId(models, "made-up-model")).toBeNull();
  });
});

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

describe("deriveWakeKindFromText — orchestration wakes", () => {
  it("recognises the five [driverless wake: ...] headers", () => {
    expect(
      deriveWakeKindFromText("[driverless wake: watchdog — child silent]\n"),
    ).toBe("watchdog");
    expect(
      deriveWakeKindFromText("[driverless wake: scheduler heartbeat]\n"),
    ).toBe("heartbeat");
    expect(
      deriveWakeKindFromText("[driverless wake: platform checkup]\n"),
    ).toBe("checkup");
    expect(
      deriveWakeKindFromText("[driverless wake: message from child x]\n"),
    ).toBe("message");
    expect(deriveWakeKindFromText("[driverless wake: child finished]")).toBe(
      "state_change",
    );
    expect(deriveWakeKindFromText("[driverless wake: child failed]")).toBe(
      "state_change",
    );
  });

  it("returns null for plain human text", () => {
    expect(deriveWakeKindFromText("hello there")).toBeNull();
  });
});

describe("deriveWakeKindFromText — share-comment wakes (X1A-110)", () => {
  it("recognises the new-comment header", () => {
    expect(
      deriveWakeKindFromText(
        "[wake: new comment on share abcd1234]\n\nAuthor: human 019e0d79\n…",
      ),
    ).toBe("comment_added");
  });

  it("recognises the resolved header", () => {
    expect(
      deriveWakeKindFromText(
        "[wake: comment thread resolved on share abcd1234]\n…",
      ),
    ).toBe("comment_resolved");
  });

  it("recognises the reopened header", () => {
    expect(
      deriveWakeKindFromText(
        "[wake: comment thread reopened on share abcd1234]\n…",
      ),
    ).toBe("comment_resolved");
  });

  it("returns null for an unknown [wake: ...] header (forward compat)", () => {
    expect(deriveWakeKindFromText("[wake: something brand new]\n")).toBeNull();
  });

  it("returns null on malformed input (missing closing bracket)", () => {
    expect(deriveWakeKindFromText("[wake: never closes")).toBeNull();
  });
});

describe("enrichWakePayload", () => {
  it("leaves a real user.message untouched", () => {
    const out = enrichWakePayload("user.message", { text: "hello" });
    expect(out.text).toBe("hello");
    expect(out.kind).toBeUndefined();
    expect(out.source).toBeUndefined();
  });

  it("tags orchestration wakes with kind + source + driverless=true", () => {
    const out = enrichWakePayload("user.message", {
      text: "[driverless wake: scheduler heartbeat]\n\nrun a checkup",
    });
    expect(out.kind).toBe("heartbeat");
    expect(out.source).toBe("platform");
    expect(out.driverless).toBe(true);
  });

  it("tags comment-wake user.message with kind + source (NO driverless flag)", () => {
    const payload = {
      text: "[wake: new comment on share abcd1234]\nBody:\nhi",
    };
    const enriched = enrichWakePayload("user.message", payload);
    expect(enriched.kind).toBe("comment_added");
    expect(enriched.source).toBe("platform");
    // Share-comment wakes are not driverless framing — they're a
    // side-channel signal, not a "no human is watching" wake.
    expect(enriched.driverless).toBeUndefined();
  });

  it("preserves an already-tagged payload (idempotent on re-process)", () => {
    const payload = {
      text: "[wake: new comment on share abcd1234]\n…",
      kind: "comment_added",
      source: "platform",
    };
    const enriched = enrichWakePayload("user.message", payload);
    expect(enriched).toEqual(payload);
  });

  it("is a no-op on non user.message types", () => {
    expect(enrichWakePayload("agent.text", { text: "hi" })).toEqual({
      text: "hi",
    });
  });
});

describe("isShareCommentWakePayload", () => {
  it("matches comment_added / comment_resolved kinds", () => {
    expect(isShareCommentWakePayload({ kind: "comment_added" })).toBe(true);
    expect(isShareCommentWakePayload({ kind: "comment_resolved" })).toBe(true);
  });

  it("rejects orchestration wake kinds", () => {
    for (const k of [
      "watchdog",
      "heartbeat",
      "checkup",
      "message",
      "state_change",
    ]) {
      expect(isShareCommentWakePayload({ kind: k })).toBe(false);
    }
  });

  it("rejects null / empty / non-object", () => {
    expect(isShareCommentWakePayload(null)).toBe(false);
    expect(isShareCommentWakePayload(undefined)).toBe(false);
    expect(isShareCommentWakePayload({})).toBe(false);
  });
});
