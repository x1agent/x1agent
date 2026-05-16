import { create } from "zustand";
import { apiFetch } from "../lib/api";

export type AccessGrantKind = "domain" | "email";
export type AccessGrantRole = "admin" | "member";

export interface AccessGrantDTO {
  id: string;
  workspace_id: string;
  kind: AccessGrantKind;
  value: string;
  default_role: AccessGrantRole | null;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
}

interface State {
  byWorkspace: Record<string, AccessGrantDTO[]>;
  status: Record<string, "idle" | "loading" | "ready" | "error">;
  error: Record<string, string | null>;

  loadForWorkspace(slug: string): Promise<void>;
  add(
    slug: string,
    input: {
      kind: AccessGrantKind;
      value: string;
      default_role?: AccessGrantRole | null;
      expires_at?: string | null;
    },
  ): Promise<void>;
  remove(slug: string, id: string): Promise<void>;
}

const set1 = <T,>(m: Record<string, T>, k: string, v: T) => ({ ...m, [k]: v });

export const useAccessGrantsStore = create<State>((set) => ({
  byWorkspace: {},
  status: {},
  error: {},

  async loadForWorkspace(slug) {
    set((s) => ({
      status: set1(s.status, slug, "loading"),
      error: set1(s.error, slug, null),
    }));
    try {
      const res = await apiFetch<{ access_grants: AccessGrantDTO[] }>(
        `/api/workspaces/${slug}/access-grants`,
      );
      set((s) => ({
        byWorkspace: set1(s.byWorkspace, slug, res.access_grants),
        status: set1(s.status, slug, "ready"),
      }));
    } catch (err) {
      set((s) => ({
        status: set1(s.status, slug, "error"),
        error: set1(s.error, slug, (err as Error).message),
      }));
    }
  },

  async add(slug, input) {
    const res = await apiFetch<{ access_grant: AccessGrantDTO }>(
      `/api/workspaces/${slug}/access-grants`,
      { method: "POST", body: JSON.stringify(input) },
    );
    set((s) => {
      const list = s.byWorkspace[slug] ?? [];
      // Replace if same (kind, value) already in list (upsert).
      const next = [
        ...list.filter(
          (g) =>
            !(g.kind === res.access_grant.kind && g.value === res.access_grant.value),
        ),
        res.access_grant,
      ].sort((a, b) =>
        a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind.localeCompare(b.kind),
      );
      return { byWorkspace: set1(s.byWorkspace, slug, next) };
    });
  },

  async remove(slug, id) {
    await apiFetch(`/api/workspaces/${slug}/access-grants/${id}`, {
      method: "DELETE",
    });
    set((s) => {
      const list = s.byWorkspace[slug] ?? [];
      return {
        byWorkspace: set1(s.byWorkspace, slug, list.filter((g) => g.id !== id)),
      };
    });
  },
}));
