import { create } from "zustand";
import type {
  SessionDTO,
  SessionListResponse,
  SessionResponse,
} from "@x1agent/shared";
import type { RuntimeType } from "@x1agent/shared";
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
    runtimeType?: RuntimeType | null,
    model?: string | null,
  ): Promise<SessionDTO>;
  cancel(
    workspaceSlug: string,
    agentId: string,
    sessionId: string,
  ): Promise<SessionDTO>;
  /**
   * Resume a terminal session. Creates a new pending session linked
   * to the original via resumed_from; the job-watcher assembles the
   * session-history ConfigMap at spawn time. Returns the new session
   * (workspace-scoped — no agent id prefix needed).
   */
  resume(
    workspaceSlug: string,
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

  async trigger(workspaceSlug, agentId, runtimeType, model) {
    const res = await apiFetch<SessionResponse>(
      listUrl(workspaceSlug, agentId),
      {
        method: "POST",
        body: JSON.stringify({
          ...(runtimeType ? { runtime_type: runtimeType } : {}),
          ...(model?.trim() ? { model: model.trim() } : {}),
        }),
      },
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

  async resume(workspaceSlug, sessionId) {
    const res = await apiFetch<SessionResponse>(
      `/api/workspaces/${workspaceSlug}/sessions/${sessionId}/resume`,
      { method: "POST" },
    );
    set((s) => {
      const agentId = res.session.agent_id;
      return {
        byAgent: {
          ...s.byAgent,
          [agentId]: [res.session, ...(s.byAgent[agentId] ?? [])],
        },
      };
    });
    return res.session;
  },
}));
