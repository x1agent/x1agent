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
  /**
   * Monotonic version bumped each time the agent re-emits an
   * `agent.share` event for this share_id while the panel is open.
   * The renderer subtree's React `key` includes this so a re-share
   * tears down and re-mounts the iframe / fetch chain — picking up
   * the new content without a manual refresh.
   */
  version: number;
}

interface ArtifactPanelState {
  open: OpenArtifact | null;
  view: "panel" | "fullscreen";
  /**
   * Whether the right-side comments sidebar is collapsed inside the
   * fullscreen view. Persists across show/close so an operator who
   * prefers focus mode doesn't have to re-collapse it every time.
   * Has no URL representation — copy-paste-shared links open with
   * the recipient's own collapse preference.
   */
  commentsCollapsed: boolean;
  show: (input: Omit<OpenArtifact, "version">) => void;
  /**
   * Replace the artifact body if (and only if) `share_id` matches the
   * currently-open panel. No-op otherwise. Bumps `version` so the
   * renderer re-mounts and re-fetches the now-fresh share content.
   */
  replaceArtifact: (payload: AgentSharePayload) => void;
  close: () => void;
  maximize: () => void;
  restore: () => void;
  toggleCommentsCollapsed: () => void;
}

// Sync the artifact-panel's open share + view-mode into the URL as
// query params so the URL is shareable across operators ("here's the
// session I'm looking at, with share X open and maximized in the
// rail"). `replaceState` instead of `pushState` because the panel is
// page-state, not a navigable history step — closing it shouldn't add
// a back-button entry.
function syncUrl(
  shareId: string | null,
  mode: "panel" | "fullscreen" = "panel",
) {
  if (typeof window === "undefined") return; // SSR safety
  const url = new URL(window.location.href);
  let dirty = false;
  if (shareId) {
    if (url.searchParams.get("share") !== shareId) {
      url.searchParams.set("share", shareId);
      dirty = true;
    }
  } else if (url.searchParams.has("share")) {
    url.searchParams.delete("share");
    dirty = true;
  }
  if (mode === "fullscreen") {
    if (url.searchParams.get("mode") !== "fullscreen") {
      url.searchParams.set("mode", "fullscreen");
      dirty = true;
    }
  } else if (url.searchParams.has("mode")) {
    url.searchParams.delete("mode");
    dirty = true;
  }
  if (dirty) window.history.replaceState({}, "", url.toString());
}

export const useArtifactPanelStore = create<ArtifactPanelState>((set, get) => ({
  open: null,
  view: "panel",
  commentsCollapsed: false,
  show: (input) => {
    syncUrl(input.artifact.share_id ?? null, "panel");
    set({ open: { ...input, version: 0 }, view: "panel" });
  },
  replaceArtifact: (payload) => {
    const current = get().open;
    if (!current) return;
    if (current.artifact.share_id !== payload.share_id) return;
    set({
      open: {
        ...current,
        artifact: payload,
        version: current.version + 1,
      },
    });
  },
  close: () => {
    syncUrl(null, "panel");
    set({ open: null, view: "panel" });
  },
  maximize: () => {
    const shareId = get().open?.artifact.share_id ?? null;
    syncUrl(shareId, "fullscreen");
    set({ view: "fullscreen" });
  },
  restore: () => {
    const shareId = get().open?.artifact.share_id ?? null;
    syncUrl(shareId, "panel");
    set({ view: "panel" });
  },
  toggleCommentsCollapsed: () =>
    set((s) => ({ commentsCollapsed: !s.commentsCollapsed })),
}));
