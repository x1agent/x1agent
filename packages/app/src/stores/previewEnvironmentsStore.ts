import { create } from "zustand";
import { apiFetch } from "../lib/api";

export type DeployStatus =
  | "pending"
  | "provisioning"
  | "ready"
  | "failed";

export interface PreviewEnvironmentDTO {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  repo_full_name: string;
  branch: string;
  last_deploy_sha: string | null;
  last_deploy_url: string | null;
  last_deploy_image_ref: string | null;
  last_deploy_status: DeployStatus;
  last_deploy_status_reason: string | null;
  last_deploy_at: string | null;
  env_var_names?: string[];
  created_at: string;
  updated_at: string;
}

interface PreviewEnvironmentsState {
  /** workspace-scoped cache: byWorkspaceSlug → list. */
  byWorkspace: Record<string, PreviewEnvironmentDTO[]>;
  /** Detail cache: env id → full row. */
  byId: Record<string, PreviewEnvironmentDTO>;
  status: Record<string, "idle" | "loading" | "ready" | "error">;
  error: Record<string, string | null>;

  loadForWorkspace(workspaceSlug: string): Promise<void>;
  loadById(workspaceSlug: string, id: string): Promise<void>;
  rename(workspaceSlug: string, id: string, title: string): Promise<void>;
  delete(workspaceSlug: string, id: string): Promise<void>;
  setEnvVarNames(
    workspaceSlug: string,
    id: string,
    envVarNames: string[],
  ): Promise<void>;
}

const setForKey = <T>(
  obj: Record<string, T>,
  key: string,
  value: T,
): Record<string, T> => ({ ...obj, [key]: value });

export const usePreviewEnvironmentsStore = create<PreviewEnvironmentsState>(
  (set, get) => ({
    byWorkspace: {},
    byId: {},
    status: {},
    error: {},

    async loadForWorkspace(workspaceSlug) {
      set((s) => ({
        status: setForKey(s.status, workspaceSlug, "loading"),
        error: setForKey(s.error, workspaceSlug, null),
      }));
      try {
        const res = await apiFetch<{
          preview_environments: PreviewEnvironmentDTO[];
        }>(`/api/workspaces/${workspaceSlug}/preview-environments`);
        const byId = { ...get().byId };
        for (const e of res.preview_environments) {
          byId[e.id] = e;
        }
        set((s) => ({
          byWorkspace: setForKey(
            s.byWorkspace,
            workspaceSlug,
            res.preview_environments,
          ),
          byId,
          status: setForKey(s.status, workspaceSlug, "ready"),
        }));
      } catch (err) {
        set((s) => ({
          status: setForKey(s.status, workspaceSlug, "error"),
          error: setForKey(s.error, workspaceSlug, (err as Error).message),
        }));
      }
    },

    async loadById(workspaceSlug, id) {
      try {
        const res = await apiFetch<{
          preview_environment: PreviewEnvironmentDTO;
        }>(`/api/workspaces/${workspaceSlug}/preview-environments/${id}`);
        set((s) => ({ byId: setForKey(s.byId, id, res.preview_environment) }));
      } catch (err) {
        set((s) => ({ error: setForKey(s.error, id, (err as Error).message) }));
      }
    },

    async rename(workspaceSlug, id, title) {
      const res = await apiFetch<{
        preview_environment: PreviewEnvironmentDTO;
      }>(`/api/workspaces/${workspaceSlug}/preview-environments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      set((s) => {
        const list = s.byWorkspace[workspaceSlug];
        const updated = res.preview_environment;
        return {
          byId: setForKey(s.byId, id, updated),
          byWorkspace: list
            ? setForKey(
                s.byWorkspace,
                workspaceSlug,
                list.map((e) => (e.id === id ? updated : e)),
              )
            : s.byWorkspace,
        };
      });
    },

    async delete(workspaceSlug, id) {
      await apiFetch(
        `/api/workspaces/${workspaceSlug}/preview-environments/${id}`,
        { method: "DELETE" },
      );
      set((s) => {
        const list = s.byWorkspace[workspaceSlug];
        const { [id]: _gone, ...byIdRest } = s.byId;
        return {
          byId: byIdRest,
          byWorkspace: list
            ? setForKey(
                s.byWorkspace,
                workspaceSlug,
                list.filter((e) => e.id !== id),
              )
            : s.byWorkspace,
        };
      });
    },

    async setEnvVarNames(workspaceSlug, id, envVarNames) {
      const res = await apiFetch<{
        preview_environment: PreviewEnvironmentDTO;
      }>(
        `/api/workspaces/${workspaceSlug}/preview-environments/${id}/env-vars`,
        { method: "PUT", body: JSON.stringify({ env_var_names: envVarNames }) },
      );
      set((s) => {
        const list = s.byWorkspace[workspaceSlug];
        const updated = res.preview_environment;
        return {
          byId: setForKey(s.byId, id, updated),
          byWorkspace: list
            ? setForKey(
                s.byWorkspace,
                workspaceSlug,
                list.map((e) => (e.id === id ? updated : e)),
              )
            : s.byWorkspace,
        };
      });
    },
  }),
);
