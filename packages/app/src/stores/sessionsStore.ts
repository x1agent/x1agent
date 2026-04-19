import { create } from "zustand";
import type {
  SessionDTO,
  SessionListResponse,
  SessionResponse,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

interface SessionsState {
  /** Keyed by agentId — each agent has its own list. */
  byAgent: Record<string, SessionDTO[]>;
  loadingAgent: string | null;
  errorByAgent: Record<string, string | null>;

  load(workspaceSlug: string, agentId: string): Promise<void>;
  trigger(
    workspaceSlug: string,
    agentId: string,
  ): Promise<SessionDTO>;
  cancel(
    workspaceSlug: string,
    agentId: string,
    sessionId: string,
  ): Promise<SessionDTO>;
}

const listUrl = (ws: string, agentId: string) =>
  `/api/workspaces/${ws}/agents/${agentId}/sessions`;

export const useSessionsStore = create<SessionsState>((set) => ({
  byAgent: {},
  loadingAgent: null,
  errorByAgent: {},

  async load(workspaceSlug, agentId) {
    set({ loadingAgent: agentId });
    try {
      const res = await apiFetch<SessionListResponse>(
        listUrl(workspaceSlug, agentId),
      );
      set((s) => ({
        byAgent: { ...s.byAgent, [agentId]: res.sessions },
        errorByAgent: { ...s.errorByAgent, [agentId]: null },
        loadingAgent: null,
      }));
    } catch (err) {
      set((s) => ({
        errorByAgent: {
          ...s.errorByAgent,
          [agentId]: (err as Error).message,
        },
        loadingAgent: null,
      }));
    }
  },

  async trigger(workspaceSlug, agentId) {
    const res = await apiFetch<SessionResponse>(
      listUrl(workspaceSlug, agentId),
      { method: "POST" },
    );
    set((s) => ({
      byAgent: {
        ...s.byAgent,
        [agentId]: [res.session, ...(s.byAgent[agentId] ?? [])],
      },
    }));
    return res.session;
  },

  async cancel(workspaceSlug, agentId, sessionId) {
    const res = await apiFetch<SessionResponse>(
      `${listUrl(workspaceSlug, agentId)}/${sessionId}/cancel`,
      { method: "POST" },
    );
    set((s) => ({
      byAgent: {
        ...s.byAgent,
        [agentId]: (s.byAgent[agentId] ?? []).map((x) =>
          x.id === sessionId ? res.session : x,
        ),
      },
    }));
    return res.session;
  },
}));
