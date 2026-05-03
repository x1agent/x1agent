import { create } from "zustand";
import { apiFetch } from "../lib/api";

export interface WorkspaceSecretRow {
  id: string;
  name: string;
  is_set: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

interface SetSecretInput {
  name: string;
  value: string;
}

interface WorkspaceSecretsState {
  byWorkspace: Record<string, WorkspaceSecretRow[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(slug: string): Promise<void>;
  setValue(slug: string, input: SetSecretInput): Promise<void>;
  remove(slug: string, name: string): Promise<void>;
}

export const useWorkspaceSecretsStore = create<WorkspaceSecretsState>(
  (set, get) => ({
    byWorkspace: {},
    loadingSlug: null,
    errorBySlug: {},

    async load(slug) {
      set({ loadingSlug: slug });
      try {
        const r = await apiFetch<{ secrets: WorkspaceSecretRow[] }>(
          `/api/workspaces/${slug}/secrets`,
        );
        set((s) => ({
          byWorkspace: { ...s.byWorkspace, [slug]: r.secrets },
          errorBySlug: { ...s.errorBySlug, [slug]: null },
        }));
      } catch (err) {
        const msg = (err as Error).message;
        set((s) => ({ errorBySlug: { ...s.errorBySlug, [slug]: msg } }));
        // Don't rethrow — many callers (the MCP card) only need
        // secrets to populate a dropdown; absence is recoverable.
      } finally {
        if (get().loadingSlug === slug) set({ loadingSlug: null });
      }
    },

    async setValue(slug, input) {
      await apiFetch(
        `/api/workspaces/${slug}/secrets/${encodeURIComponent(input.name)}`,
        {
          method: "PUT",
          body: JSON.stringify({ value: input.value }),
        },
      );
      await get().load(slug);
    },

    async remove(slug, name) {
      await apiFetch(
        `/api/workspaces/${slug}/secrets/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: (s.byWorkspace[slug] ?? []).filter((x) => x.name !== name),
        },
      }));
    },
  }),
);
