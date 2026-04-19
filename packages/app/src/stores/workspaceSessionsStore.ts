import { create } from "zustand";
import type {
  WorkspaceSessionListResponse,
  WorkspaceSessionRow,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

interface WorkspaceSessionsState {
  bySlug: Record<string, WorkspaceSessionRow[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(workspaceSlug: string): Promise<void>;
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
  }),
);
