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

export interface CreateImageInput {
  name: string;
  display_name: string;
  description?: string | null;
  dockerfile_source: string;
}

export interface UpdateImagePatch {
  display_name?: string;
  description?: string | null;
  dockerfile_source?: string;
}

interface ImagesState {
  bySlug: Record<string, AgentImage[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;
  load(slug: string): Promise<void>;
  create(slug: string, input: CreateImageInput): Promise<AgentImage>;
  update(slug: string, id: string, patch: UpdateImagePatch): Promise<AgentImage>;
  rebuild(slug: string, id: string): Promise<AgentImage>;
  remove(slug: string, id: string): Promise<void>;
}

function replaceOrPrepend(
  list: AgentImage[],
  next: AgentImage,
): AgentImage[] {
  const idx = list.findIndex((i) => i.id === next.id);
  if (idx === -1) {
    // New row: presets stay at the top, workspace rows are appended in
    // alphabetical order (matches the server-side ORDER BY).
    if (next.is_preset) return [next, ...list];
    const wsRows = list.filter((i) => !i.is_preset);
    const presets = list.filter((i) => i.is_preset);
    const merged = [...wsRows, next].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    return [...presets, ...merged];
  }
  const copy = list.slice();
  copy[idx] = next;
  return copy;
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

  async create(slug, input) {
    const created = await apiFetch<AgentImage>(
      `/api/workspaces/${slug}/agent-images`,
      { method: "POST", body: JSON.stringify(input) },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [slug]: replaceOrPrepend(s.bySlug[slug] ?? [], created),
      },
    }));
    return created;
  },

  async update(slug, id, patch) {
    const updated = await apiFetch<AgentImage>(
      `/api/workspaces/${slug}/agent-images/${id}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [slug]: replaceOrPrepend(s.bySlug[slug] ?? [], updated),
      },
    }));
    return updated;
  },

  async rebuild(slug, id) {
    const updated = await apiFetch<AgentImage>(
      `/api/workspaces/${slug}/agent-images/${id}/rebuild`,
      { method: "POST" },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [slug]: replaceOrPrepend(s.bySlug[slug] ?? [], updated),
      },
    }));
    return updated;
  },

  async remove(slug, id) {
    await apiFetch<{ ok: true }>(
      `/api/workspaces/${slug}/agent-images/${id}`,
      { method: "DELETE" },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [slug]: (s.bySlug[slug] ?? []).filter((i) => i.id !== id),
      },
    }));
  },
}));

/**
 * Returns true while any row in the workspace's catalog is in a
 * transient build state. Lets the panel start a poll loop and stop
 * automatically once everything is terminal.
 */
export function hasTransientBuilds(images: AgentImage[]): boolean {
  return images.some(
    (i) => i.build_status === "pending" || i.build_status === "building",
  );
}
