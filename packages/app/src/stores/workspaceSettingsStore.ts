import { create } from "zustand";
import { apiFetch } from "../lib/api";

/**
 * Wire shape for the workspace's security/policy toggles. Mirrors
 * `WorkspaceSettings` in packages/domains/workspaces/src/domain.
 *
 * Add new settings here in lockstep with the domain — the api
 * tolerates unknown keys on PATCH but never echoes them back, so
 * stale clients silently lose writes for keys they don't know about.
 */
export type OauthMcpsOnOrchestratorsMode = "off" | "on_attended" | "on";

export interface WorkspaceSettings {
  oauthMcpsOnOrchestrators: OauthMcpsOnOrchestratorsMode;
  adminMcpEnabled: boolean;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  settings: WorkspaceSettings;
}

interface WorkspaceSettingsState {
  bySlug: Record<string, Workspace | undefined>;
  /** "loading" / "ready" / "error" per slug; idle when never fetched. */
  statusBySlug: Record<string, "idle" | "loading" | "ready" | "error">;
  load: (slug: string) => Promise<void>;
  patch: (
    slug: string,
    patch: Partial<WorkspaceSettings>,
  ) => Promise<Workspace>;
}

export const useWorkspaceSettingsStore = create<WorkspaceSettingsState>(
  (set, get) => ({
    bySlug: {},
    statusBySlug: {},

    load: async (slug) => {
      const s = get().statusBySlug[slug];
      if (s === "loading" || s === "ready") return;
      set((prev) => ({
        statusBySlug: { ...prev.statusBySlug, [slug]: "loading" },
      }));
      try {
        const ws = await apiFetch<Workspace>(
          `/api/workspaces/${encodeURIComponent(slug)}`,
        );
        set((prev) => ({
          bySlug: { ...prev.bySlug, [slug]: ws },
          statusBySlug: { ...prev.statusBySlug, [slug]: "ready" },
        }));
      } catch {
        set((prev) => ({
          statusBySlug: { ...prev.statusBySlug, [slug]: "error" },
        }));
      }
    },

    patch: async (slug, patch) => {
      const updated = await apiFetch<Workspace>(
        `/api/workspaces/${encodeURIComponent(slug)}/settings`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      set((prev) => ({
        bySlug: { ...prev.bySlug, [slug]: updated },
        statusBySlug: { ...prev.statusBySlug, [slug]: "ready" },
      }));
      return updated;
    },
  }),
);
