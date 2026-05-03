import { create } from "zustand";
import { apiFetch } from "../lib/api";

export interface AgentEnvBinding {
  id: string;
  agent_id: string;
  env_name: string;
  secret_name: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface SetBindingInput {
  envName: string;
  secretName: string;
}

interface AgentEnvBindingsState {
  byAgentKey: Record<string, AgentEnvBinding[]>;
  loadingKey: string | null;
  errorByKey: Record<string, string | null>;

  load(slug: string, agentId: string): Promise<void>;
  setBinding(slug: string, agentId: string, input: SetBindingInput): Promise<void>;
  remove(slug: string, agentId: string, envName: string): Promise<void>;
}

const key = (slug: string, agentId: string) => `${slug}:${agentId}`;

export const useAgentEnvBindingsStore = create<AgentEnvBindingsState>(
  (set, get) => ({
    byAgentKey: {},
    loadingKey: null,
    errorByKey: {},

    async load(slug, agentId) {
      const k = key(slug, agentId);
      set({ loadingKey: k });
      try {
        const r = await apiFetch<{ bindings: AgentEnvBinding[] }>(
          `/api/workspaces/${slug}/agents/${agentId}/env`,
        );
        set((s) => ({
          byAgentKey: { ...s.byAgentKey, [k]: r.bindings },
          errorByKey: { ...s.errorByKey, [k]: null },
        }));
      } catch (err) {
        const msg = (err as Error).message;
        set((s) => ({ errorByKey: { ...s.errorByKey, [k]: msg } }));
      } finally {
        if (get().loadingKey === k) set({ loadingKey: null });
      }
    },

    async setBinding(slug, agentId, input) {
      await apiFetch(
        `/api/workspaces/${slug}/agents/${agentId}/env/${encodeURIComponent(input.envName)}`,
        {
          method: "PUT",
          body: JSON.stringify({ secret_name: input.secretName }),
        },
      );
      await get().load(slug, agentId);
    },

    async remove(slug, agentId, envName) {
      await apiFetch(
        `/api/workspaces/${slug}/agents/${agentId}/env/${encodeURIComponent(envName)}`,
        { method: "DELETE" },
      );
      const k = key(slug, agentId);
      set((s) => ({
        byAgentKey: {
          ...s.byAgentKey,
          [k]: (s.byAgentKey[k] ?? []).filter((b) => b.env_name !== envName),
        },
      }));
    },
  }),
);
