import { create } from "zustand";
import { slugify } from "@x1agent/kernel";
import { apiFetch } from "../lib/api";

/**
 * Draft state for the "create a workspace" form (mounted at /workspaces/new).
 *
 * Why a store and not raw `useState`?
 *
 * - The slug auto-tracks the name until the user manually edits the slug
 *   field. Two coupled inputs with shared derived state are exactly the
 *   cross-component concern CLAUDE.md's "Frontend state management" section
 *   says belongs in zustand.
 * - The submit action calls `apiFetch` and writes server state — the same
 *   shape every other store in this directory follows (load/attach/update
 *   that hits `apiFetch` and writes the result back).
 * - Tests can `useWorkspaceCreateStore.setState(...)` to reset between
 *   cases, and assert against `getState()` instead of mocking React state.
 *
 * Lifecycle:
 *
 * - `setName(value)` — updates `name` and, while `slugDirty` is false,
 *   recomputes `slug` via `slugify(value)`.
 * - `setSlug(raw)` — lowercases, writes `slug`, and flips `slugDirty` to
 *   true unless the new value is empty (clearing the field re-enables
 *   auto-tracking) or the value happens to equal `slugify(name)` (typing
 *   the auto-derived slug by hand isn't a meaningful "manual" edit).
 * - `submit()` — POSTs to `/api/workspaces` and returns the resulting slug
 *   on success. On failure it stores the error message and clears the
 *   submitting flag; on success it leaves the state populated so the
 *   caller can navigate.
 * - `reset()` — drops the draft. Call on mount of a fresh form.
 */
interface WorkspaceCreateState {
  name: string;
  slug: string;
  /**
   * True once the user has manually edited the slug field with a value
   * that doesn't match the auto-derived one. While false, `slug`
   * auto-tracks `name`. Clearing the slug field flips it back to false.
   */
  slugDirty: boolean;
  submitting: boolean;
  error: string | null;

  setName: (value: string) => void;
  setSlug: (raw: string) => void;
  reset: () => void;
  submit: () => Promise<{ slug: string } | null>;
}

const INITIAL = {
  name: "",
  slug: "",
  slugDirty: false,
  submitting: false,
  error: null,
} as const;

export const useWorkspaceCreateStore = create<WorkspaceCreateState>(
  (set, get) => ({
    ...INITIAL,

    setName: (value) => {
      set((s) => ({
        name: value,
        // While the slug is still tracking the name, keep them in sync.
        // Once dirty, leave the slug alone — manual edits win.
        slug: s.slugDirty ? s.slug : slugify(value),
      }));
    },

    setSlug: (raw) => {
      const next = raw.toLowerCase();
      set((s) => ({
        slug: next,
        // Empty slug re-enables auto-tracking so the user can recover from
        // a mistake without retyping the name. A manual edit that happens
        // to equal slugify(name) is also treated as "still tracking" — it
        // hasn't actually diverged.
        slugDirty: next !== "" && next !== slugify(s.name),
      }));
    },

    reset: () => set({ ...INITIAL }),

    submit: async () => {
      const { name, slug } = get();
      const trimmedName = name.trim();
      if (!trimmedName) return null;
      set({ submitting: true, error: null });
      try {
        const ws = await apiFetch<{ slug: string }>(`/api/workspaces`, {
          method: "POST",
          body: JSON.stringify({ slug, name: trimmedName }),
        });
        // Leave the form populated so callers can navigate based on the
        // returned slug; navigation lives in the component, not here.
        set({ submitting: false });
        return ws;
      } catch (err) {
        set({ submitting: false, error: (err as Error).message });
        return null;
      }
    },
  }),
);
