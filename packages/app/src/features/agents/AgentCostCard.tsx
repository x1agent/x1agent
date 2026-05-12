import { useEffect, useMemo, useState } from "react";
import {
  formatTokens,
  formatUsd,
  useCostStore,
  type AgentCost,
  type AgentCostWindow,
} from "../../stores/costStore";

interface Props {
  workspaceSlug: string;
  agentId: string;
}

const WINDOWS: readonly AgentCostWindow[] = ["24h", "7d", "30d", "all"];
const WINDOW_LABEL: Record<AgentCostWindow, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "All",
};

/**
 * View 3 — agent detail page cost across all the agent's sessions.
 *
 * Locked decisions:
 *   - Default window is 7d (matches the standup cadence).
 *   - Toggles: 24h / 7d / 30d / All.
 *   - Big number muted with dashed underline, same hover behavior as
 *     View 1.
 *   - Sparkline below the number, accent color, ~40px tall.
 *   - Top-sessions table below: session id (truncated), started at,
 *     cost (sorted desc).
 *   - No live-dot (static rollup, not a live stream).
 */
export function AgentCostCard({ workspaceSlug, agentId }: Props) {
  // 7d default is locked.
  const [window, setWindow] = useState<AgentCostWindow>("7d");
  const loadAgentCost = useCostStore((s) => s.loadAgentCost);
  const cost = useCostStore(
    (s) => s.agentCostByKey[`${agentId}:${window}`],
  ) as AgentCost | undefined;
  const loading = useCostStore(
    (s) => s.loadingByKey[`agent:${agentId}:${window}`] ?? false,
  );

  useEffect(() => {
    void loadAgentCost(workspaceSlug, agentId, window);
  }, [workspaceSlug, agentId, window, loadAgentCost]);

  const sparkPath = useMemo(
    () => buildSparkline(cost?.byDay ?? []),
    [cost],
  );

  return (
    <div
      className="rounded-md border border-border-soft bg-surface-muted/30 p-4"
      data-testid="agent-cost-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium text-fg">Cost</h2>
        <span className="text-xs text-fg-faint">across all sessions</span>
        <div
          className="ml-auto inline-flex gap-1 rounded-md border border-border-soft p-0.5"
          role="tablist"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={w === window}
              onClick={() => setWindow(w)}
              className={`rounded px-2 py-0.5 text-[11px] transition ${
                w === window
                  ? "bg-accent-soft text-fg"
                  : "text-fg-muted hover:text-fg"
              }`}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-baseline gap-3">
        <BigCost cost={cost} live={false} loading={loading} />
        <span className="text-xs text-fg-faint">
          {window === "all" ? "all-time" : `last ${window}`}
        </span>
      </div>

      {/* Sparkline. Accent-color line, ~40px tall. Hidden when there's
          no usage so the card doesn't sport a flat baseline that
          looks like a bug. */}
      {(cost?.byDay?.length ?? 0) > 0 ? (
        <svg
          className="mt-2 w-full"
          viewBox="0 0 200 40"
          preserveAspectRatio="none"
          height={40}
          aria-label="Daily cost sparkline"
        >
          <path
            d={sparkPath}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <div className="mt-2 text-[11px] text-fg-faint">
          No usage in this window.
        </div>
      )}

      {(cost?.topSessions?.length ?? 0) > 0 ? (
        <div className="mt-3 border-t border-border-soft pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-faint">
            Top sessions
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-fg-faint">
                <th className="text-left font-normal">session</th>
                <th className="text-left font-normal">started</th>
                <th className="text-right font-normal">cost</th>
              </tr>
            </thead>
            <tbody>
              {cost!.topSessions.map((s) => (
                <tr key={s.sessionId} className="border-t border-border-soft/40">
                  <td className="py-1">
                    <a
                      className="font-mono text-fg-muted hover:underline"
                      href={`/workspaces/${workspaceSlug}/sessions/${s.sessionId}`}
                      title={s.summary ?? s.sessionId}
                    >
                      {s.sessionId.slice(0, 8)}…
                    </a>
                  </td>
                  <td className="py-1 text-fg-faint">
                    {formatRelative(s.startedAt)}
                  </td>
                  <td className="py-1 text-right text-fg-muted">
                    {formatUsd(s.costUsdEstimate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function BigCost({
  cost,
  live,
  loading,
}: {
  cost: AgentCost | undefined;
  live: boolean;
  loading: boolean;
}) {
  const amount = cost?.totals.costUsdEstimate ?? 0;
  return (
    <span className="group relative inline-flex items-baseline">
      <span
        className="cursor-help border-b border-dashed border-fg-faint text-2xl font-medium text-fg-muted"
        tabIndex={0}
        aria-describedby="agent-cost-tooltip"
      >
        {loading && !cost ? "…" : formatUsd(amount)}
      </span>
      <span
        id="agent-cost-tooltip"
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden min-w-[18rem] rounded-md border border-border-strong bg-surface-elevated px-3 py-2 text-xs text-fg shadow-lg group-hover:block group-focus-within:block"
      >
        <div className="mb-1 font-medium text-fg">
          Agent cost — breakdown by model
        </div>
        <div className="mb-2 border-t border-border-soft" />
        {(cost?.byModel?.length ?? 0) === 0 ? (
          <div className="text-fg-faint">No model usage in this window</div>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <tbody>
              {cost!.byModel.map((m) => (
                <tr key={m.model}>
                  <td className="font-mono text-fg-muted">{m.model}</td>
                  <td className="text-right text-fg">
                    {formatUsd(m.costUsdEstimate)}
                  </td>
                  <td className="pl-2 text-right text-fg-faint">
                    {formatTokens(m.inputTokens + m.outputTokens)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-border-soft">
                <td className="pt-1 text-fg-faint">Total</td>
                <td className="pt-1 text-right font-medium">
                  {formatUsd(amount)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
        {live ? (
          <div className="mt-2 text-[10px] text-fg-faint">
            Live · updates within ~2s
          </div>
        ) : null}
      </span>
    </span>
  );
}

/**
 * Build a sparkline SVG path from per-day cost rows. The path is fitted
 * into a 200×40 viewBox (preserveAspectRatio="none" stretches to the
 * card width). Empty input gives an empty path so the SVG is invisible
 * — the caller hides the SVG anyway in that case, but keeping the
 * helper total here makes it testable in isolation.
 *
 * Exported so the test file can pin the geometry.
 */
export function buildSparkline(
  byDay: readonly { day: string; costUsdEstimate: number }[],
): string {
  if (byDay.length === 0) return "";
  const sorted = byDay.slice().sort((a, b) => a.day.localeCompare(b.day));
  const max = Math.max(...sorted.map((d) => d.costUsdEstimate), 1e-9);
  const n = sorted.length;
  const points = sorted.map((d, i) => {
    const x = n === 1 ? 0 : (i / (n - 1)) * 200;
    // 4-pixel top padding so the stroke isn't clipped on max-day.
    const y = 40 - (d.costUsdEstimate / max) * 32 - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M ${points.join(" L ")}`;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const ms = now - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  // Fall through to date for older entries.
  return d.toISOString().slice(0, 10);
}
