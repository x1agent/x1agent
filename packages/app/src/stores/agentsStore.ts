import { create } from "zustand";
import type {
  AgentDTO,
  AgentListResponse,
  CreateAgentRequest,
  UpdateAgentRequest,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

interface AgentsState {
  bySlug: Record<string, AgentDTO[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(workspaceSlug: string): Promise<void>;
  get(workspaceSlug: string, agentSlug: string): AgentDTO | undefined;
  create(
    workspaceSlug: string,
    input: CreateAgentRequest,
  ): Promise<AgentDTO>;
  update(
    workspaceSlug: string,
    agentId: string,
    patch: UpdateAgentRequest,
  ): Promise<AgentDTO>;
  remove(workspaceSlug: string, agentId: string): Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  bySlug: {},
  loadingSlug: null,
  errorBySlug: {},

  async load(workspaceSlug) {
    set({ loadingSlug: workspaceSlug });
    try {
      const res = await apiFetch<AgentListResponse>(
        `/api/workspaces/${workspaceSlug}/agents`,
      );
      set((s) => ({
        bySlug: { ...s.bySlug, [workspaceSlug]: res.agents },
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

  get(workspaceSlug, agentSlug) {
    return (get().bySlug[workspaceSlug] ?? []).find(
      (a) => a.slug === agentSlug,
    );
  },

  async create(workspaceSlug, input) {
    const res = await apiFetch<{ agent: AgentDTO }>(
      `/api/workspaces/${workspaceSlug}/agents`,
      { method: "POST", body: JSON.stringify(input) },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [workspaceSlug]: [res.agent, ...(s.bySlug[workspaceSlug] ?? [])],
      },
    }));
    return res.agent;
  },

  async update(workspaceSlug, agentId, patch) {
    const res = await apiFetch<{ agent: AgentDTO }>(
      `/api/workspaces/${workspaceSlug}/agents/${agentId}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [workspaceSlug]: (s.bySlug[workspaceSlug] ?? []).map((a) =>
          a.id === agentId ? res.agent : a,
        ),
      },
    }));
    return res.agent;
  },

  async remove(workspaceSlug, agentId) {
    await apiFetch(
      `/api/workspaces/${workspaceSlug}/agents/${agentId}`,
      { method: "DELETE" },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [workspaceSlug]: (s.bySlug[workspaceSlug] ?? []).filter(
          (a) => a.id !== agentId,
        ),
      },
    }));
  },
}));
