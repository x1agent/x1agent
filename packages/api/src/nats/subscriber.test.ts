import { describe, it, expect } from "bun:test";
import {
  deriveWakeKindFromText,
  enrichWakePayload,
  isShareCommentWakePayload,
} from "./subscriber";

describe("deriveWakeKindFromText — orchestration wakes (existing behaviour)", () => {
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

  it("still tags orchestration wakes with driverless=true (regression)", () => {
    const payload = {
      text: "[driverless wake: scheduler heartbeat]\n…",
    };
    const enriched = enrichWakePayload("user.message", payload);
    expect(enriched.kind).toBe("heartbeat");
    expect(enriched.source).toBe("platform");
    expect(enriched.driverless).toBe(true);
  });

  it("leaves a real user.message untouched", () => {
    const payload = { text: "what's the weather?" };
    const enriched = enrichWakePayload("user.message", payload);
    expect(enriched.kind).toBeUndefined();
    expect(enriched.source).toBeUndefined();
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
    for (const k of ["watchdog", "heartbeat", "checkup", "message", "state_change"]) {
      expect(isShareCommentWakePayload({ kind: k })).toBe(false);
    }
  });

  it("rejects null / empty / non-object", () => {
    expect(isShareCommentWakePayload(null)).toBe(false);
    expect(isShareCommentWakePayload(undefined)).toBe(false);
    expect(isShareCommentWakePayload({})).toBe(false);
  });
});
