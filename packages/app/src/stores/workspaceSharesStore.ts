import { create } from "zustand";
import { apiFetch } from "../lib/api";

/**
 * Workspace-level shares index. Flat list of every `agent.share`
 * event in the workspace, enriched with the originating agent + the
 * session's triggered_at so the UI can sort and link. Loaded on
 * demand, kept per-slug so different workspaces don't overwrite each
 * other.
 */

export interface WorkspaceShareEntry {
  share_id: string;
  share_type:
    | "image"
    | "svg"
    | "site"
    | "csv"
    | "json"
    | "archive"
    | "code"
    | "document"
    | "file";
  title: string;
  path: string;
  files: { path: string; size: number; content_type: string }[];
  total_size: number;
  entry_point?: string | null;
  session_id: string;
  session_triggered_at: string;
  agent: { id: string; slug: string; name: string };
  created_at: string;
}

interface WorkspaceSharesListResponse {
  shares: WorkspaceShareEntry[];
}

interface State {
  bySlug: Record<string, WorkspaceShareEntry[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(workspaceSlug: string): Promise<void>;
}

export const useWorkspaceSharesStore = create<State>((set) => ({
  bySlug: {},
  loadingSlug: null,
  errorBySlug: {},

  async load(workspaceSlug) {
    set({ loadingSlug: workspaceSlug });
    try {
      const res = await apiFetch<WorkspaceSharesListResponse>(
        `/api/workspaces/${workspaceSlug}/shares`,
      );
      set((s) => ({
        bySlug: { ...s.bySlug, [workspaceSlug]: res.shares },
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
}));
