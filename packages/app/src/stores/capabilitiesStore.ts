import { create } from "zustand";
import { apiFetch } from "../lib/api";

/**
 * Mirrors the wire shape from GET /api/capabilities. A null/empty value
 * means the operator did not install a provider for that domain — the
 * UI must hide the corresponding surface (nav entry, CTA, pickers).
 */
export interface Capabilities {
  graph: string | null;
  vector: string | null;
  messaging: string[];
}

interface CapabilitiesState {
  caps: Capabilities | null;
  status: "idle" | "loading" | "ready" | "error";
  fetch: () => Promise<void>;
}

const EMPTY: Capabilities = { graph: null, vector: null, messaging: [] };

export const useCapabilitiesStore = create<CapabilitiesState>((set, get) => ({
  caps: null,
  status: "idle",
  fetch: async () => {
    if (get().status === "loading" || get().status === "ready") return;
    set({ status: "loading" });
    try {
      const caps = await apiFetch<Capabilities>("/api/capabilities");
      set({ caps, status: "ready" });
    } catch {
      // Network blip on boot — fail closed so UI hides everything provider-
      // backed rather than offering features that will 502 on click.
      set({ caps: EMPTY, status: "error" });
    }
  },
}));

/** Convenience selectors. Components that just need a boolean should
 * call these so the gate logic stays in one place — if we later add
 * `vector` as a separate-from-graph capability for collections, we only
 * change the selector, not every callsite. */
export const useHasCollections = () =>
  useCapabilitiesStore((s) => Boolean(s.caps?.graph));
