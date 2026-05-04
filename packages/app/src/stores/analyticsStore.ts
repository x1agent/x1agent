import { create } from "zustand";
import { apiFetch } from "../lib/api";
import {
  DEFAULT_PRESET,
  type RangePreset,
  presetToRange,
  type DateRange,
} from "../features/analytics/range";

/**
 * Wire shape mirrors what the api returns from
 * GET /api/workspaces/:slug/token-usage. Values are integers in
 * tokens; cost is a USD float.
 */
export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsdEstimate: number;
}
export interface TokenUsageByAgent extends TokenUsageTotals {
  agentId: string | null;
  agentName: string | null;
  agentSlug: string | null;
}
export interface TokenUsageByModel extends TokenUsageTotals {
  model: string;
}
export interface TokenUsageByDay extends TokenUsageTotals {
  day: string;
}
export type TriggerSource = "user" | "scheduler" | "agent";
export interface TokenUsageByTriggerSource extends TokenUsageTotals {
  triggeredBy: TriggerSource;
}
export interface TokenUsageByUser extends TokenUsageTotals {
  userId: string;
  userName: string | null;
  userEmail: string | null;
}
export interface TokenUsageByDayByTriggerSource extends TokenUsageTotals {
  day: string;
  triggeredBy: TriggerSource;
}
export interface AnalyticsRollup {
  range: { since: string; until: string };
  totals: TokenUsageTotals;
  byAgent: TokenUsageByAgent[];
  byModel: TokenUsageByModel[];
  byDay: TokenUsageByDay[];
  byTriggerSource: TokenUsageByTriggerSource[];
  byUser: TokenUsageByUser[];
  byDayByTriggerSource: TokenUsageByDayByTriggerSource[];
}

interface PerWorkspace {
  preset: RangePreset;
  /** Set when preset === "custom"; otherwise unused. */
  customSince: string | null;
  customUntil: string | null;
  data: AnalyticsRollup | null;
  loading: boolean;
  error: string | null;
}

interface AnalyticsState {
  byWorkspace: Record<string, PerWorkspace>;
  setPreset(workspaceSlug: string, preset: RangePreset): void;
  setCustomRange(
    workspaceSlug: string,
    since: string | null,
    until: string | null,
  ): void;
  /** Load against the workspace's current preset + custom range. */
  load(workspaceSlug: string): Promise<void>;
}

function defaultPerWorkspace(): PerWorkspace {
  return {
    preset: DEFAULT_PRESET,
    customSince: null,
    customUntil: null,
    data: null,
    loading: false,
    error: null,
  };
}

function getOrInit(
  state: AnalyticsState,
  slug: string,
): PerWorkspace {
  return state.byWorkspace[slug] ?? defaultPerWorkspace();
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  byWorkspace: {},

  setPreset(slug, preset) {
    set((s) => {
      const ws = getOrInit(s, slug);
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: { ...ws, preset },
        },
      };
    });
    void get().load(slug);
  },

  setCustomRange(slug, since, until) {
    set((s) => {
      const ws = getOrInit(s, slug);
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: { ...ws, customSince: since, customUntil: until },
        },
      };
    });
    // Only auto-fetch when both ends are set; partial picks cause no
    // network noise as the user types.
    if (since && until) void get().load(slug);
  },

  async load(slug) {
    const ws = getOrInit(get(), slug);
    const range: DateRange = presetToRange(ws.preset, new Date(), {
      since: ws.customSince,
      until: ws.customUntil,
    });
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [slug]: { ...getOrInit(s, slug), loading: true, error: null },
      },
    }));
    try {
      const data = await apiFetch<AnalyticsRollup>(
        `/api/workspaces/${slug}/token-usage?since=${range.since}&until=${range.until}`,
      );
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: { ...getOrInit(s, slug), data, loading: false, error: null },
        },
      }));
    } catch (err) {
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: {
            ...getOrInit(s, slug),
            loading: false,
            error: (err as Error).message,
          },
        },
      }));
    }
  },
}));
