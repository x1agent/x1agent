import { create } from "zustand";
import type { WorkspaceMembership } from "@x1agent/shared";
import { useAuthStore } from "./authStore";

interface WorkspaceState {
  activeSlug: string | null;

  /** Set on mount by reading the URL path. */
  syncSlugFromUrl: () => void;
  setActiveSlug: (slug: string | null) => void;

  /**
   * Navigate to the same sub-page within a different workspace. The
   * current path's first two segments are `/workspaces/:slug`; we
   * swap the slug and keep the rest. Falls back to the workspace
   * home if the current page isn't workspace-scoped.
   */
  switchWorkspace: (slug: string) => void;

  /** Convenience — derived from the auth store's memberships. */
  membershipFor: (slug: string) => WorkspaceMembership | undefined;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  activeSlug: null,

  syncSlugFromUrl: () => {
    if (typeof window === "undefined") return;
    const match = window.location.pathname.match(/^\/workspaces\/([^/]+)/);
    set({ activeSlug: match ? match[1]! : null });
  },

  setActiveSlug: (slug) => set({ activeSlug: slug }),

  switchWorkspace: (slug) => {
    if (typeof window === "undefined") return;
    const current = window.location.pathname;
    const swapped = current.replace(
      /^\/workspaces\/[^/]+(\/.*)?$/,
      `/workspaces/${slug}$1`,
    );
    window.location.href = swapped.startsWith("/workspaces/")
      ? swapped
      : `/workspaces/${slug}`;
  },

  membershipFor: (slug) => {
    const memberships = useAuthStore.getState().memberships;
    return memberships.find((m) => m.slug === slug);
  },
}));
