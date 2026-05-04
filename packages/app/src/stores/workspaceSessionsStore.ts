import { create } from "zustand";
import type {
  WorkspaceSessionListResponse,
  WorkspaceSessionRow,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

interface BulkDeleteResult {
  deleted: string[];
  not_found: string[];
}

interface WorkspaceSessionsState {
  bySlug: Record<string, WorkspaceSessionRow[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(workspaceSlug: string): Promise<void>;
  /**
   * Permanently delete the given sessions. Optimistic — the rows
   * disappear from the cache immediately, then we reconcile against
   * the server's `not_found` list (which we treat as already-gone).
   */
  bulkDelete(
    workspaceSlug: string,
    sessionIds: readonly string[],
  ): Promise<BulkDeleteResult>;
}

export const useWorkspaceSessionsStore = create<WorkspaceSessionsState>(
  (set) => ({
    bySlug: {},
    loadingSlug: null,
    errorBySlug: {},

    async load(workspaceSlug) {
      set({ loadingSlug: workspaceSlug });
      try {
        const res = await apiFetch<WorkspaceSessionListResponse>(
          `/api/workspaces/${workspaceSlug}/sessions`,
        );
        set((s) => ({
          bySlug: { ...s.bySlug, [workspaceSlug]: res.sessions },
          errorBySlug: { ...s.errorBySlug, [workspaceSlug]: null },
          loadingSlug: null,
        }));
      } catch (err) {
        set((s) => ({
          errorBySlug: {
            ...s.errorBySlug,
            [workspaceSlug]: (err as Error).message,
          },
          loadingSlug: null,
        }));
      }
    },

    async bulkDelete(workspaceSlug, sessionIds) {
      const ids = Array.from(new Set(sessionIds));
      if (ids.length === 0) {
        return { deleted: [], not_found: [] };
      }
      // Optimistic removal — drop matching rows from the cache before
      // the round-trip. If the server fails we'll re-load to recover.
      const idSet = new Set(ids);
      const previous = useWorkspaceSessionsStore.getState().bySlug[workspaceSlug];
      set((s) => ({
        bySlug: {
          ...s.bySlug,
          [workspaceSlug]: (s.bySlug[workspaceSlug] ?? []).filter(
            (r) => !idSet.has(r.id),
          ),
        },
      }));
      try {
        const res = await apiFetch<BulkDeleteResult>(
          `/api/workspaces/${workspaceSlug}/sessions/_bulk-delete`,
          {
            method: "POST",
            body: JSON.stringify({ session_ids: ids }),
          },
        );
        return res;
      } catch (err) {
        // Roll back the optimistic removal so the user doesn't think
        // sessions vanished if the API rejected the request.
        if (previous) {
          set((s) => ({
            bySlug: { ...s.bySlug, [workspaceSlug]: previous },
          }));
        }
        throw err;
      }
    },
  }),
);
