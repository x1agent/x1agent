import { create } from "zustand";
import type {
  AgentReposResponse,
  GitHubConfigResponse,
  InstallationDTO,
  InstallationListResponse,
  InstallationRepoDTO,
} from "@x1agent/shared";
import { apiFetch, API_BASE } from "../lib/api";

interface GitHubState {
  config: GitHubConfigResponse | null;
  installations: InstallationDTO[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;

  /** repos indexed by installation_id */
  reposById: Record<number, InstallationRepoDTO[]>;
  reposLoadingId: number | null;

  /** agent repo attachments, keyed by agentId */
  agentRepos: Record<string, AgentReposResponse>;

  loadConfig(): Promise<void>;
  loadInstallations(): Promise<void>;
  loadReposForInstallation(id: number): Promise<void>;
  startInstall(returnTo?: string): void;

  loadAgentRepos(workspaceSlug: string, agentId: string): Promise<void>;
  attachRepo(
    workspaceSlug: string,
    agentId: string,
    installationId: number,
    repoFullName: string,
    options?: { branch?: string; auto_push?: boolean },
  ): Promise<void>;
  updateRepo(
    workspaceSlug: string,
    agentId: string,
    repoFullName: string,
    patch: { branch?: string; auto_push?: boolean },
  ): Promise<void>;
  detachRepo(
    workspaceSlug: string,
    agentId: string,
    repoFullName: string,
  ): Promise<void>;
}

export const useGitHubStore = create<GitHubState>((set, get) => ({
  config: null,
  installations: [],
  status: "idle",
  error: null,
  reposById: {},
  reposLoadingId: null,
  agentRepos: {},

  async loadConfig() {
    try {
      const cfg = await apiFetch<GitHubConfigResponse>("/auth/github/config");
      set({ config: cfg });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadInstallations() {
    set({ status: "loading", error: null });
    try {
      const res = await apiFetch<InstallationListResponse>(
        "/api/installations",
      );
      set({ installations: res.installations, status: "ready" });
    } catch (err) {
      set({ status: "error", error: (err as Error).message });
    }
  },

  async loadReposForInstallation(id) {
    set({ reposLoadingId: id });
    try {
      const res = await apiFetch<{ repos: InstallationRepoDTO[] }>(
        `/api/installations/${id}/repos`,
      );
      set((s) => ({
        reposById: { ...s.reposById, [id]: res.repos },
        reposLoadingId: null,
      }));
    } catch (err) {
      set({ reposLoadingId: null, error: (err as Error).message });
    }
  },

  startInstall(returnTo) {
    // Default: remember the page the user is on so the callback drops
    // them back where they started. Callers can override (e.g. from
    // the Account screen where the default would loop back on itself).
    const path =
      returnTo ??
      (typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : undefined);
    const url = new URL(`${API_BASE}/auth/github/install`);
    if (path) url.searchParams.set("return_to", path);
    window.location.href = url.toString();
  },

  async loadAgentRepos(workspaceSlug, agentId) {
    const res = await apiFetch<AgentReposResponse>(
      `/api/workspaces/${workspaceSlug}/agents/${agentId}/repos`,
    );
    set((s) => ({ agentRepos: { ...s.agentRepos, [agentId]: res } }));
  },

  async attachRepo(workspaceSlug, agentId, installationId, repoFullName, options) {
    await apiFetch(
      `/api/workspaces/${workspaceSlug}/agents/${agentId}/repos`,
      {
        method: "POST",
        body: JSON.stringify({
          installation_id: installationId,
          repo_full_name: repoFullName,
          branch: options?.branch,
          auto_push: options?.auto_push,
        }),
      },
    );
    await get().loadAgentRepos(workspaceSlug, agentId);
  },

  async updateRepo(workspaceSlug, agentId, repoFullName, patch) {
    await apiFetch(
      `/api/workspaces/${workspaceSlug}/agents/${agentId}/repos/${encodeURIComponent(repoFullName)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    await get().loadAgentRepos(workspaceSlug, agentId);
  },

  async detachRepo(workspaceSlug, agentId, repoFullName) {
    await apiFetch(
      `/api/workspaces/${workspaceSlug}/agents/${agentId}/repos/${encodeURIComponent(repoFullName)}`,
      { method: "DELETE" },
    );
    await get().loadAgentRepos(workspaceSlug, agentId);
  },
}));
