import { describe, it, expect, beforeEach } from "bun:test";
import {
  useTypingIndicatorStore,
  selectSessionIndicatorMap,
  extractCorrelatedEventId,
  TYPING_INDICATOR_TTL_MS,
} from "../stores/typingIndicatorStore";

const SESSION = "session-a";
const OTHER_SESSION = "session-b";

function reset() {
  useTypingIndicatorStore.setState({ bySession: {} });
}

describe("typingIndicatorStore", () => {
  beforeEach(reset);

  describe("add", () => {
    it("stores an indicator keyed by event_id, derives expires_at from started_at + TTL", () => {
      const started = "2026-05-13T00:00:00.000Z";
      useTypingIndicatorStore.getState().add(SESSION, {
        event_id: "wake-1",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      const map = useTypingIndicatorStore
        .getState()
        .bySession[SESSION];
      expect(map).toBeDefined();
      const ind = map!["wake-1"];
      expect(ind).toBeDefined();
      expect(ind!.expires_at).toBe(
        Date.parse(started) + TYPING_INDICATOR_TTL_MS,
      );
    });

    it("is idempotent on re-delivery of the same event_id — the original TTL window survives", () => {
      const started = "2026-05-13T00:00:00.000Z";
      const store = useTypingIndicatorStore.getState();
      store.add(SESSION, {
        event_id: "wake-1",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      const first = useTypingIndicatorStore
        .getState()
        .bySession[SESSION]!["wake-1"]!;
      // Re-deliver with a different (later) started_at — must NOT
      // overwrite the original record.
      store.add(SESSION, {
        event_id: "wake-1",
        share_id: null,
        thread_id: null,
        started_at: "2026-05-13T00:00:05.000Z",
        wake_source: "user",
      });
      const second = useTypingIndicatorStore
        .getState()
        .bySession[SESSION]!["wake-1"]!;
      expect(second.expires_at).toBe(first.expires_at);
      expect(second.started_at).toBe(first.started_at);
    });

    it("scopes indicators per session — sessions don't leak into each other", () => {
      const started = "2026-05-13T00:00:00.000Z";
      useTypingIndicatorStore.getState().add(SESSION, {
        event_id: "wake-1",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      useTypingIndicatorStore.getState().add(OTHER_SESSION, {
        event_id: "wake-2",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      const all = useTypingIndicatorStore.getState().bySession;
      expect(Object.keys(all[SESSION] ?? {})).toEqual(["wake-1"]);
      expect(Object.keys(all[OTHER_SESSION] ?? {})).toEqual(["wake-2"]);
    });
  });

  describe("clearByEventId", () => {
    it("removes the indicator with the matching event_id and leaves siblings", () => {
      const started = "2026-05-13T00:00:00.000Z";
      const store = useTypingIndicatorStore.getState();
      store.add(SESSION, {
        event_id: "wake-1",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      store.add(SESSION, {
        event_id: "wake-2",
        share_id: "share-1",
        thread_id: "thread-1",
        started_at: started,
        wake_source: "share_comment",
      });
      store.clearByEventId(SESSION, "wake-1");
      const after = useTypingIndicatorStore.getState().bySession[SESSION] ?? {};
      expect(after["wake-1"]).toBeUndefined();
      expect(after["wake-2"]).toBeDefined();
    });

    it("is a no-op for unknown event_ids", () => {
      const before = useTypingIndicatorStore.getState();
      useTypingIndicatorStore
        .getState()
        .clearByEventId(SESSION, "does-not-exist");
      const after = useTypingIndicatorStore.getState();
      expect(after.bySession).toBe(before.bySession);
    });
  });

  describe("sweepExpired (60s TTL safety net)", () => {
    it("drops indicators whose expires_at is at or before now", () => {
      const started = "2026-05-13T00:00:00.000Z";
      useTypingIndicatorStore.getState().add(SESSION, {
        event_id: "wake-old",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      const baseExpires = Date.parse(started) + TYPING_INDICATOR_TTL_MS;
      // Force-time the sweep to *after* expiry.
      useTypingIndicatorStore.getState().sweepExpired(SESSION, baseExpires + 1);
      const after = useTypingIndicatorStore.getState().bySession[SESSION] ?? {};
      expect(after["wake-old"]).toBeUndefined();
    });

    it("preserves live indicators when sweeping before expiry", () => {
      const started = "2026-05-13T00:00:00.000Z";
      useTypingIndicatorStore.getState().add(SESSION, {
        event_id: "wake-live",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      const baseExpires = Date.parse(started) + TYPING_INDICATOR_TTL_MS;
      useTypingIndicatorStore.getState().sweepExpired(SESSION, baseExpires - 1);
      const after = useTypingIndicatorStore.getState().bySession[SESSION] ?? {};
      expect(after["wake-live"]).toBeDefined();
    });
  });

  describe("clearAllForSession", () => {
    it("drops every indicator for the session and leaves others", () => {
      const started = "2026-05-13T00:00:00.000Z";
      const store = useTypingIndicatorStore.getState();
      store.add(SESSION, {
        event_id: "wake-1",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      store.add(OTHER_SESSION, {
        event_id: "wake-2",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      store.clearAllForSession(SESSION);
      const all = useTypingIndicatorStore.getState().bySession;
      expect(all[SESSION]).toBeUndefined();
      expect(Object.keys(all[OTHER_SESSION] ?? {})).toEqual(["wake-2"]);
    });
  });

  describe("selectSessionIndicatorMap referential stability", () => {
    it("returns the same empty reference across renders when the session has no indicators", () => {
      const sel = selectSessionIndicatorMap(SESSION);
      const a = sel(useTypingIndicatorStore.getState());
      const b = sel(useTypingIndicatorStore.getState());
      expect(a).toBe(b);
    });
  });

  describe("extractCorrelatedEventId", () => {
    it("picks up top-level event_id", () => {
      expect(
        extractCorrelatedEventId({ event_id: "wake-1" }),
      ).toBe("wake-1");
    });
    it("picks up top-level in_reply_to", () => {
      expect(
        extractCorrelatedEventId({ in_reply_to: "wake-2" }),
      ).toBe("wake-2");
    });
    it("picks up top-level triggered_by", () => {
      expect(
        extractCorrelatedEventId({ triggered_by: "wake-3" }),
      ).toBe("wake-3");
    });
    it("falls through to payload fields", () => {
      expect(
        extractCorrelatedEventId({ payload: { event_id: "wake-4" } }),
      ).toBe("wake-4");
      expect(
        extractCorrelatedEventId({ payload: { in_reply_to: "wake-5" } }),
      ).toBe("wake-5");
      expect(
        extractCorrelatedEventId({ payload: { triggered_by: "wake-6" } }),
      ).toBe("wake-6");
    });
    it("returns null when no correlation field is set", () => {
      expect(
        extractCorrelatedEventId({ payload: { unrelated: "x" } }),
      ).toBeNull();
      expect(extractCorrelatedEventId({})).toBeNull();
    });
    it("ignores empty-string ids", () => {
      expect(
        extractCorrelatedEventId({
          event_id: "",
          payload: { in_reply_to: "wake-7" },
        }),
      ).toBe("wake-7");
    });
  });

  describe("clear correlation flow (end-to-end on the store)", () => {
    it("overlapping wakes clear independently", () => {
      const started = "2026-05-13T00:00:00.000Z";
      const store = useTypingIndicatorStore.getState();
      store.add(SESSION, {
        event_id: "wake-user",
        share_id: null,
        thread_id: null,
        started_at: started,
        wake_source: "user",
      });
      store.add(SESSION, {
        event_id: "wake-comment",
        share_id: "share-1",
        thread_id: "thread-1",
        started_at: started,
        wake_source: "share_comment",
      });

      // Simulate the wiring in SessionRoot: an arbitrary agent
      // emission carrying `in_reply_to: wake-user` clears only that
      // indicator — the share-comment wake survives.
      const correlated = extractCorrelatedEventId({
        payload: { in_reply_to: "wake-user" },
      });
      expect(correlated).toBe("wake-user");
      store.clearByEventId(SESSION, correlated!);

      const after = useTypingIndicatorStore.getState().bySession[SESSION] ?? {};
      expect(after["wake-user"]).toBeUndefined();
      expect(after["wake-comment"]).toBeDefined();
    });
  });
});
