import { create } from "zustand";
import { apiFetch } from "../lib/api";

export type BuildStatus =
  | "pending"
  | "building"
  | "succeeded"
  | "failed"
  | "ready";

export interface AgentImage {
  id: string;
  workspace_id: string | null;
  name: string;
  display_name: string;
  description: string | null;
  built_ref: string;
  is_preset: boolean;
  dockerfile_source: string;
  build_status: BuildStatus;
  build_log: string;
  last_built_at: string | null;
  created_at: string;
}

interface ImagesState {
  bySlug: Record<string, AgentImage[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;
  load(slug: string): Promise<void>;
}

export const useImagesStore = create<ImagesState>((set) => ({
  bySlug: {},
  loadingSlug: null,
  errorBySlug: {},
  async load(slug) {
    set({ loadingSlug: slug });
    try {
      const res = await apiFetch<{ images: AgentImage[] }>(
        `/api/workspaces/${slug}/agent-images`,
      );
      set((s) => ({
        bySlug: { ...s.bySlug, [slug]: res.images },
        errorBySlug: { ...s.errorBySlug, [slug]: null },
        loadingSlug: null,
      }));
    } catch (err) {
      set((s) => ({
        errorBySlug: { ...s.errorBySlug, [slug]: (err as Error).message },
        loadingSlug: null,
      }));
    }
  },
}));
