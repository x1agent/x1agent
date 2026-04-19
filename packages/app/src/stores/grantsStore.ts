import { create } from "zustand";
import type { CreateGrantRequest, GrantDTO } from "@x1agent/shared";
import { apiFetch } from "../lib/api";

interface GrantsState {
  /** Keyed by `${workspaceSlug}:${agentId}` — spawn grants held by that agent. */
  spawnByAgent: Record<string, GrantDTO[]>;
  loadingKey: string | null;
  errorKey: string | null;
  error: string | null;

  loadSpawnGrants(workspaceSlug: string, agentId: string): Promise<void>;
  createGrant(
    workspaceSlug: string,
    body: CreateGrantRequest,
  ): Promise<GrantDTO>;
  revokeGrant(workspaceSlug: string, grantId: string): Promise<void>;
}

export const useGrantsStore = create<GrantsState>((set, get) => ({
  spawnByAgent: {},
  loadingKey: null,
  errorKey: null,
  error: null,

  async loadSpawnGrants(workspaceSlug, agentId) {
    const key = `${workspaceSlug}:${agentId}`;
    set({ loadingKey: key, error: null, errorKey: null });
    try {
      const qs = new URLSearchParams({
        agent_subject_id: agentId,
        grant_type: "spawn",
      });
      const res = await apiFetch<{ grants: GrantDTO[] }>(
        `/api/workspaces/${workspaceSlug}/grants?${qs.toString()}`,
      );
      set((s) => ({
        spawnByAgent: { ...s.spawnByAgent, [key]: res.grants },
        loadingKey: null,
      }));
    } catch (err) {
      set({
        loadingKey: null,
        errorKey: key,
        error: (err as Error).message,
      });
    }
  },

  async createGrant(workspaceSlug, body) {
    const res = await apiFetch<{ grant: GrantDTO }>(
      `/api/workspaces/${workspaceSlug}/grants`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    if (body.agent_subject_id && body.grant_type === "spawn") {
      await get().loadSpawnGrants(workspaceSlug, body.agent_subject_id);
    }
    return res.grant;
  },

  async revokeGrant(workspaceSlug, grantId) {
    await apiFetch(`/api/workspaces/${workspaceSlug}/grants/${grantId}`, {
      method: "DELETE",
    });
    // Refresh any loaded agent views containing this grant.
    const current = get().spawnByAgent;
    const updated: Record<string, GrantDTO[]> = {};
    for (const [key, rows] of Object.entries(current)) {
      updated[key] = rows.filter((g) => g.id !== grantId);
    }
    set({ spawnByAgent: updated });
  },
}));
