import { create } from "zustand";
import type { AgentSharePayload } from "../features/sessions/ShareCard";

/**
 * Session-scoped store for the right-rail artifact panel. Keeps the
 * heavy share renderer mounted only while the user is actively viewing
 * an artifact — clicking a pill opens it, clicking another pill swaps
 * it, closing collapses to nothing-mounted.
 *
 * `view` toggles between the inline side rail and a fullscreen overlay
 * (the "maximize" affordance). The maximized variant reuses the same
 * renderer; only the chrome changes.
 */
export interface OpenArtifact {
  workspaceSlug: string;
  sessionId: string;
  artifact: AgentSharePayload;
}

interface ArtifactPanelState {
  open: OpenArtifact | null;
  view: "panel" | "fullscreen";
  show: (input: OpenArtifact) => void;
  close: () => void;
  maximize: () => void;
  restore: () => void;
}

export const useArtifactPanelStore = create<ArtifactPanelState>((set) => ({
  open: null,
  view: "panel",
  show: (input) => set({ open: input, view: "panel" }),
  close: () => set({ open: null, view: "panel" }),
  maximize: () => set({ view: "fullscreen" }),
  restore: () => set({ view: "panel" }),
}));
