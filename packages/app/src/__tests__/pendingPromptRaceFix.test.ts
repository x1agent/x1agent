import { afterEach, describe, expect, it } from "bun:test";
import { usePendingPromptStore } from "../stores/pendingPromptStore";

/**
 * Regression: SessionRoot's pending-prompt drain effect used to gate
 * on `bridgeRef.current` (a `useRef`) while its dependency array only
 * carried `[events, sessionId, takePendingPrompt]`. When the events
 * HTTP fetch returned `session.started` BEFORE the async WS bridge
 * connect resolved, the effect fired once (bridgeRef still null),
 * bailed, and never re-ran — because nothing in its deps changed
 * when the bridge later flipped the ref. Result: a user typed a
 * prompt on the agent detail page → SpawnSessionCard queued it in
 * sessionStorage → SessionRoot loaded, drained nothing, the session
 * sat idle and the agent never received the message.
 *
 * The fix promotes the bridge-online signal to a `useState`
 * (`bridgeReady`) and lists it in the effect's deps. This file pins
 * the store contract the fix relies on (`set` persists, `take` returns
 * and clears) — the effect's re-run semantics are component-level
 * behaviour covered by the SessionRoot integration tests; here we
 * lock the store invariants the drain depends on so a future
 * regression to the store can't reintroduce the race indirectly.
 */

afterEach(() => {
  usePendingPromptStore.setState({ bySessionId: {} });
});

describe("pendingPromptStore — invariants the SessionRoot drain depends on", () => {
  it("set() persists by session id and survives until take()", () => {
    const store = usePendingPromptStore.getState();
    store.set("019e85c3-72d5-720d-aecb-c6e84dab6f7d", "  hello world  ");
    const state = usePendingPromptStore.getState().bySessionId;
    expect(state["019e85c3-72d5-720d-aecb-c6e84dab6f7d"]).toBe("hello world");
  });

  it("set() no-ops on empty / whitespace-only text", () => {
    const store = usePendingPromptStore.getState();
    store.set("s1", "");
    store.set("s1", "   ");
    expect(usePendingPromptStore.getState().bySessionId).toEqual({});
  });

  it("take() returns the pending value and atomically clears it (drain can't refire)", () => {
    const store = usePendingPromptStore.getState();
    store.set("s2", "draft");
    const first = usePendingPromptStore.getState().take("s2");
    expect(first).toBe("draft");
    const second = usePendingPromptStore.getState().take("s2");
    expect(second).toBeNull();
  });

  it("take() returns null when there's no queued prompt — drain bails cleanly", () => {
    expect(usePendingPromptStore.getState().take("never-queued")).toBeNull();
  });
});
