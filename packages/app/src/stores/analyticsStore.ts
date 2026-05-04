import { create } from "zustand";
import { apiFetch } from "../lib/api";
import {
  DEFAULT_PRESET,
  type RangePreset,
  presetToRange,
  priorRange,
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
  /** Optional savings vs paying full input rate for cached tokens. */
  cacheSavingsUsdEstimate?: number;
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
  /** Toggle for the prior-period comparison. When on, the store
   * fetches a second rollup against priorRange() so KPI deltas + the
   * compare overlay have data. */
  compareEnabled: boolean;
  data: AnalyticsRollup | null;
  prior: AnalyticsRollup | null;
  loading: boolean;
  loadingPrior: boolean;
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
  setCompareEnabled(workspaceSlug: string, enabled: boolean): void;
  /** Load against the workspace's current preset + custom range.
   * Also loads the prior period if compareEnabled. */
  load(workspaceSlug: string): Promise<void>;
}

function defaultPerWorkspace(): PerWorkspace {
  return {
    preset: DEFAULT_PRESET,
    customSince: null,
    customUntil: null,
    compareEnabled: false,
    data: null,
    prior: null,
    loading: false,
    loadingPrior: false,
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

  setCompareEnabled(slug, enabled) {
    set((s) => {
      const ws = getOrInit(s, slug);
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: { ...ws, compareEnabled: enabled, prior: enabled ? ws.prior : null },
        },
      };
    });
    if (enabled) void get().load(slug);
  },

  async load(slug) {
    const ws = getOrInit(get(), slug);
    const now = new Date();
    const range: DateRange = presetToRange(ws.preset, now, {
      since: ws.customSince,
      until: ws.customUntil,
    });
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [slug]: {
          ...getOrInit(s, slug),
          loading: true,
          error: null,
          loadingPrior: ws.compareEnabled,
        },
      },
    }));

    const fetchRollup = (r: DateRange) =>
      apiFetch<AnalyticsRollup>(
        `/api/workspaces/${slug}/token-usage?since=${r.since}&until=${r.until}`,
      );

    try {
      // Current period and prior period race in parallel — second
      // request is conditional on the toggle so plain fetches stay
      // single-network-trip when compare is off.
      const currentP = fetchRollup(range);
      const priorP = ws.compareEnabled
        ? fetchRollup(
            priorRange(ws.preset, now, {
              since: ws.customSince,
              until: ws.customUntil,
            }),
          )
        : Promise.resolve<AnalyticsRollup | null>(null);
      const [data, prior] = await Promise.all([currentP, priorP]);
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: {
            ...getOrInit(s, slug),
            data,
            prior,
            loading: false,
            loadingPrior: false,
            error: null,
          },
        },
      }));
    } catch (err) {
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [slug]: {
            ...getOrInit(s, slug),
            loading: false,
            loadingPrior: false,
            error: (err as Error).message,
          },
        },
      }));
    }
  },
}));
