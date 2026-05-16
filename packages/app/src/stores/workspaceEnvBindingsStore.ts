import { create } from "zustand";
import { apiFetch } from "../lib/api";

export interface WorkspaceEnvBindingDTO {
  id: string;
  workspace_id: string;
  env_name: string;
  secret_name: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface State {
  byWorkspace: Record<string, WorkspaceEnvBindingDTO[]>;
  status: Record<string, "idle" | "loading" | "ready" | "error">;
  error: Record<string, string | null>;

  loadForWorkspace(slug: string): Promise<void>;
  set(
    slug: string,
    envName: string,
    secretName: string,
  ): Promise<void>;
  remove(slug: string, envName: string): Promise<void>;
}

const set1 = <T,>(m: Record<string, T>, k: string, v: T) => ({ ...m, [k]: v });

export const useWorkspaceEnvBindingsStore = create<State>((set) => ({
  byWorkspace: {},
  status: {},
  error: {},

  async loadForWorkspace(slug) {
    set((s) => ({
      status: set1(s.status, slug, "loading"),
      error: set1(s.error, slug, null),
    }));
    try {
      const res = await apiFetch<{ bindings: WorkspaceEnvBindingDTO[] }>(
        `/api/workspaces/${slug}/env-bindings`,
      );
      set((s) => ({
        byWorkspace: set1(s.byWorkspace, slug, res.bindings),
        status: set1(s.status, slug, "ready"),
      }));
    } catch (err) {
      set((s) => ({
        status: set1(s.status, slug, "error"),
        error: set1(s.error, slug, (err as Error).message),
      }));
    }
  },

  async set(slug, envName, secretName) {
    const res = await apiFetch<WorkspaceEnvBindingDTO>(
      `/api/workspaces/${slug}/env-bindings/${encodeURIComponent(envName)}`,
      { method: "PUT", body: JSON.stringify({ secret_name: secretName }) },
    );
    set((s) => {
      const list = s.byWorkspace[slug] ?? [];
      const next = [
        ...list.filter((b) => b.env_name !== res.env_name),
        res,
      ].sort((a, b) => a.env_name.localeCompare(b.env_name));
      return { byWorkspace: set1(s.byWorkspace, slug, next) };
    });
  },

  async remove(slug, envName) {
    await apiFetch(
      `/api/workspaces/${slug}/env-bindings/${encodeURIComponent(envName)}`,
      { method: "DELETE" },
    );
    set((s) => {
      const list = s.byWorkspace[slug] ?? [];
      return {
        byWorkspace: set1(s.byWorkspace, slug, list.filter((b) => b.env_name !== envName)),
      };
    });
  },
}));
