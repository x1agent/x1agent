import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Queue of initial prompts waiting to be auto-sent once the matching
 * session's agent pod signals `session.started`. Populated by the Run
 * card on the agent detail page before it navigates; drained by the
 * session detail page after NATS is live.
 *
 * Persisted to sessionStorage so the value survives the full-page
 * navigation that the Run card does (`window.location.href = ...`).
 * Scoped to the tab — opening the session in a new tab won't replay
 * the prompt.
 */
interface State {
  bySessionId: Record<string, string>;

  set(sessionId: string, text: string): void;
  /** Read + clear in one call so the effect can't double-fire. */
  take(sessionId: string): string | null;
  clear(sessionId: string): void;
}

export const usePendingPromptStore = create<State>()(
  persist(
    (set, get) => ({
      bySessionId: {},

      set(sessionId, text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        set((s) => ({
          bySessionId: { ...s.bySessionId, [sessionId]: trimmed },
        }));
      },

      take(sessionId) {
        const existing = get().bySessionId[sessionId];
        if (!existing) return null;
        set((s) => {
          const next = { ...s.bySessionId };
          delete next[sessionId];
          return { bySessionId: next };
        });
        return existing;
      },

      clear(sessionId) {
        set((s) => {
          if (!(sessionId in s.bySessionId)) return s;
          const next = { ...s.bySessionId };
          delete next[sessionId];
          return { bySessionId: next };
        });
      },
    }),
    {
      name: "x1agent:pending-prompts",
      storage: createJSONStorage(() =>
        typeof window === "undefined"
          ? (undefined as unknown as Storage)
          : window.sessionStorage,
      ),
    },
  ),
);
