import { create } from "zustand";
import type { Role } from "@x1agent/shared";
import { apiFetch } from "../lib/api";

export interface WorkspaceMemberDTO {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  added_at: string;
}

interface WorkspaceMembersState {
  bySlug: Record<string, WorkspaceMemberDTO[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(slug: string): Promise<void>;
  changeRole(slug: string, userId: string, role: Role): Promise<void>;
  remove(slug: string, userId: string): Promise<void>;
}

export const useWorkspaceMembersStore = create<WorkspaceMembersState>(
  (set, get) => ({
    bySlug: {},
    loadingSlug: null,
    errorBySlug: {},

    async load(slug) {
      set({ loadingSlug: slug });
      try {
        const res = await apiFetch<{ members: WorkspaceMemberDTO[] }>(
          `/api/workspaces/${slug}/members`,
        );
        set((s) => ({
          bySlug: { ...s.bySlug, [slug]: res.members },
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

    async changeRole(slug, userId, role) {
      const res = await apiFetch<{
        member: { user_id: string; role: Role; added_at: string };
      }>(`/api/workspaces/${slug}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      // Optimistically patch the cached row so the UI reflects the
      // change immediately. Email/name don't change here.
      const current = get().bySlug[slug] ?? [];
      set((s) => ({
        bySlug: {
          ...s.bySlug,
          [slug]: current.map((m) =>
            m.user_id === userId ? { ...m, role: res.member.role } : m,
          ),
        },
      }));
    },

    async remove(slug, userId) {
      await apiFetch(`/api/workspaces/${slug}/members/${userId}`, {
        method: "DELETE",
      });
      const current = get().bySlug[slug] ?? [];
      set((s) => ({
        bySlug: {
          ...s.bySlug,
          [slug]: current.filter((m) => m.user_id !== userId),
        },
      }));
    },
  }),
);
