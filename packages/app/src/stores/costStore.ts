import { create } from "zustand";
import { apiFetch } from "../lib/api";

/**
 * Cost surfacing — X1A-37.
 *
 * One store for all three views (session, session-tree, agent rollup)
 * to keep the data flow uniform: components select the slice they want
 * by key, never call `apiFetch` directly. Selectors compose `?? null`
 * outside the selector to keep referential stability — the project's
 * established foot-gun mitigation (see app/CLAUDE.md).
 */

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsdEstimate: number;
  cacheSavingsUsdEstimate?: number;
}

export interface TokenUsageByModel extends TokenUsageTotals {
  model: string;
}

export interface TokenUsageByDay extends TokenUsageTotals {
  /** YYYY-MM-DD in UTC. */
  day: string;
}

export interface SessionCost {
  sessionId: string;
  totals: TokenUsageTotals;
  byModel: TokenUsageByModel[];
}

export interface SessionTreeChild extends TokenUsageTotals {
  sessionId: string;
  depth: number;
  summary: string | null;
  agentSlug: string | null;
  agentName: string | null;
}

export interface SessionTreeCost {
  rootSessionId: string;
  parent: SessionCost;
  children: SessionTreeChild[];
  totals: TokenUsageTotals;
}

export type AgentCostWindow = "24h" | "7d" | "30d" | "all";

export interface AgentSessionCost extends TokenUsageTotals {
  sessionId: string;
  startedAt: string;
  summary: string | null;
}

export interface AgentCost {
  agentId: string;
  window: AgentCostWindow;
  totals: TokenUsageTotals;
  byModel: TokenUsageByModel[];
  byDay: TokenUsageByDay[];
  topSessions: AgentSessionCost[];
}

interface State {
  sessionCostBySession: Record<string, SessionCost>;
  treeCostBySession: Record<string, SessionTreeCost>;
  agentCostByKey: Record<string, AgentCost>;
  loadingByKey: Record<string, boolean>;
  errorByKey: Record<string, string | null>;
  loadSessionCost(workspaceSlug: string, sessionId: string): Promise<void>;
  loadSessionTreeCost(
    workspaceSlug: string,
    sessionId: string,
  ): Promise<void>;
  loadAgentCost(
    workspaceSlug: string,
    agentId: string,
    window: AgentCostWindow,
  ): Promise<void>;
}

function agentKey(agentId: string, window: AgentCostWindow): string {
  return `${agentId}:${window}`;
}

export const useCostStore = create<State>((set) => ({
  sessionCostBySession: {},
  treeCostBySession: {},
  agentCostByKey: {},
  loadingByKey: {},
  errorByKey: {},

  async loadSessionCost(workspaceSlug, sessionId) {
    const key = `session:${sessionId}`;
    set((s) => ({
      loadingByKey: { ...s.loadingByKey, [key]: true },
      errorByKey: { ...s.errorByKey, [key]: null },
    }));
    try {
      const data = await apiFetch<SessionCost>(
        `/api/workspaces/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}/cost`,
      );
      set((s) => ({
        sessionCostBySession: {
          ...s.sessionCostBySession,
          [sessionId]: data,
        },
        loadingByKey: { ...s.loadingByKey, [key]: false },
      }));
    } catch (err) {
      set((s) => ({
        loadingByKey: { ...s.loadingByKey, [key]: false },
        errorByKey: {
          ...s.errorByKey,
          [key]: (err as Error).message,
        },
      }));
    }
  },

  async loadSessionTreeCost(workspaceSlug, sessionId) {
    const key = `tree:${sessionId}`;
    set((s) => ({
      loadingByKey: { ...s.loadingByKey, [key]: true },
      errorByKey: { ...s.errorByKey, [key]: null },
    }));
    try {
      const data = await apiFetch<SessionTreeCost>(
        `/api/workspaces/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}/cost-tree`,
      );
      set((s) => ({
        treeCostBySession: { ...s.treeCostBySession, [sessionId]: data },
        loadingByKey: { ...s.loadingByKey, [key]: false },
      }));
    } catch (err) {
      set((s) => ({
        loadingByKey: { ...s.loadingByKey, [key]: false },
        errorByKey: { ...s.errorByKey, [key]: (err as Error).message },
      }));
    }
  },

  async loadAgentCost(workspaceSlug, agentId, window) {
    const key = `agent:${agentKey(agentId, window)}`;
    set((s) => ({
      loadingByKey: { ...s.loadingByKey, [key]: true },
      errorByKey: { ...s.errorByKey, [key]: null },
    }));
    try {
      const data = await apiFetch<AgentCost>(
        `/api/workspaces/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(agentId)}/cost?window=${window}`,
      );
      set((s) => ({
        agentCostByKey: {
          ...s.agentCostByKey,
          [agentKey(agentId, window)]: data,
        },
        loadingByKey: { ...s.loadingByKey, [key]: false },
      }));
    } catch (err) {
      set((s) => ({
        loadingByKey: { ...s.loadingByKey, [key]: false },
        errorByKey: { ...s.errorByKey, [key]: (err as Error).message },
      }));
    }
  },
}));

/**
 * Format a USD amount for display. Sub-dollar costs get four decimals
 * because the orchestrator standup quotes spend like "$0.0123" on cheap
 * sessions; once you cross $1 two decimals reads cleaner. Identical to
 * the existing TokenUsagePanel formatter so the dashboard and the
 * detail page show the same number for the same data.
 */
export function formatUsd(n: number): string {
  if (!isFinite(n)) return "$0.00";
  if (n < 1) return `$${n.toFixed(4)}`;
  if (n < 10) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
