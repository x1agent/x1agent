import { create } from "zustand";

/**
 * Transient "agent is thinking" indicators (X1A-104) backed by the
 * `session.agent_thinking` WS event emitted by X1A-103. Each entry
 * is keyed by the wake-triggering `event_id` so overlapping wakes
 * (e.g. user message + share-comment reply mid-turn) each manage
 * their own indicator.
 *
 * Lifecycle:
 *   - `add` writes a new active indicator with `expires_at = started_at + TTL_MS`.
 *   - `clearByEventId` is called when an agent emission carries the
 *     same `event_id` (or `in_reply_to` / `triggered_by` referencing
 *     it) — the deterministic correlation contract from X1A-103.
 *   - `sweepExpired` is the 60s client-side TTL safety net so a
 *     pod-death scenario doesn't leave a ghost indicator on screen.
 *
 * The store is intentionally NOT persisted — indicators are transient,
 * not part of session history. A page refresh always comes up clean.
 */

export interface ActiveIndicator {
  event_id: string;
  share_id: string | null;
  thread_id: string | null;
  started_at: string;
  /** Epoch millis. `started_at + TTL_MS`. */
  expires_at: number;
  wake_source: string;
}

interface State {
  /** Per-session map of `event_id → ActiveIndicator`. */
  bySession: Record<string, Record<string, ActiveIndicator>>;

  add(sessionId: string, indicator: Omit<ActiveIndicator, "expires_at"> & { expires_at?: number }): void;
  clearByEventId(sessionId: string, eventId: string): void;
  sweepExpired(sessionId: string, nowMs?: number): void;
  clearAllForSession(sessionId: string): void;
}

/** 60 second client-side TTL safety net (X1A-103 spec). */
export const TYPING_INDICATOR_TTL_MS = 60_000;

export const useTypingIndicatorStore = create<State>((set) => ({
  bySession: {},

  add(sessionId, indicator) {
    const startedMs = Date.parse(indicator.started_at);
    const baseMs = Number.isFinite(startedMs) ? startedMs : Date.now();
    const expires_at = indicator.expires_at ?? baseMs + TYPING_INDICATOR_TTL_MS;
    const next: ActiveIndicator = {
      event_id: indicator.event_id,
      share_id: indicator.share_id,
      thread_id: indicator.thread_id,
      started_at: indicator.started_at,
      wake_source: indicator.wake_source,
      expires_at,
    };
    set((s) => {
      const cur = s.bySession[sessionId] ?? {};
      // Idempotent on event_id — a re-delivery of the same event
      // (WS reconnect, accidental double-subscribe) shouldn't reset
      // the TTL window. Preserve the first record.
      if (cur[next.event_id]) return s;
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { ...cur, [next.event_id]: next },
        },
      };
    });
  },

  clearByEventId(sessionId, eventId) {
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur || !cur[eventId]) return s;
      const next = { ...cur };
      delete next[eventId];
      return {
        bySession: { ...s.bySession, [sessionId]: next },
      };
    });
  },

  sweepExpired(sessionId, nowMs = Date.now()) {
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur) return s;
      let mutated = false;
      const next: Record<string, ActiveIndicator> = {};
      for (const [k, v] of Object.entries(cur)) {
        if (v.expires_at <= nowMs) {
          mutated = true;
          continue;
        }
        next[k] = v;
      }
      if (!mutated) return s;
      return {
        bySession: { ...s.bySession, [sessionId]: next },
      };
    });
  },

  clearAllForSession(sessionId) {
    set((s) => {
      if (!s.bySession[sessionId]) return s;
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));

// Module-level stable empty refs — selectors that compose `?? EMPTY`
// must use a shared reference so React doesn't error #185 from a
// new `[]` / `{}` minted each render.
const EMPTY_MAP: Record<string, ActiveIndicator> = Object.freeze({});

/**
 * Stable selector returning the indicators map for a session. Use
 * `selectActiveIndicators` (the array form) for components that just
 * iterate.
 */
export function selectSessionIndicatorMap(
  sessionId: string,
): (s: State) => Record<string, ActiveIndicator> {
  return (s) => s.bySession[sessionId] ?? EMPTY_MAP;
}

/**
 * Inspect an arbitrary agent emission and return the wake `event_id`
 * it's correlating back to, or `null` if none is carried. Matches the
 * X1A-103 propagation contract: any of
 *   - top-level `event_id`
 *   - top-level `in_reply_to`
 *   - top-level `triggered_by`
 *   - nested under `payload.{event_id, in_reply_to, triggered_by}`
 * are accepted. The first non-empty UUID wins.
 *
 * Exported so the WS subscription handler can call it without
 * importing private helpers.
 */
export function extractCorrelatedEventId(
  ev: { payload?: unknown } & Record<string, unknown>,
): string | null {
  const fields = ["event_id", "in_reply_to", "triggered_by"] as const;
  const candidates: unknown[] = [];
  for (const f of fields) candidates.push(ev[f]);
  if (ev.payload && typeof ev.payload === "object") {
    const p = ev.payload as Record<string, unknown>;
    for (const f of fields) candidates.push(p[f]);
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}
