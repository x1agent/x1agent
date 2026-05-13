import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
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
  const [topOpen, setTopOpen] = useState(false);
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
  const hasTopSessions = (cost?.topSessions?.length ?? 0) > 0;
  const TopChevron = topOpen ? ChevronDown : ChevronRight;

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
        <BigCost
          cost={cost}
          loading={loading}
          toggleable={hasTopSessions}
          open={topOpen}
          onToggle={() => setTopOpen((v) => !v)}
        />
        <span className="text-xs text-fg-faint">
          {window === "all" ? "all-time" : `last ${window}`}
        </span>
        {hasTopSessions ? (
          <button
            type="button"
            onClick={() => setTopOpen((v) => !v)}
            aria-expanded={topOpen}
            aria-controls="agent-cost-top-sessions"
            className="ml-auto inline-flex items-center text-fg-muted hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
            data-testid="agent-cost-top-toggle"
            title={topOpen ? "Hide top sessions" : "Show top sessions"}
          >
            <TopChevron className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Sparkline. Accent-color line, ~40px tall. Hidden when there's
          no usage so the card doesn't sport a flat baseline that
          looks like a bug. Hovering reveals per-day cost in a tooltip. */}
      {(cost?.byDay?.length ?? 0) > 0 ? (
        <Sparkline byDay={cost!.byDay} path={sparkPath} />
      ) : (
        <div className="mt-2 text-[11px] text-fg-faint">
          No usage in this window.
        </div>
      )}

      {hasTopSessions && topOpen ? (
        <div
          id="agent-cost-top-sessions"
          className="mt-3 border-t border-border-soft pt-2"
        >
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
  loading,
  toggleable,
  open,
  onToggle,
}: {
  cost: AgentCost | undefined;
  loading: boolean;
  toggleable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const amount = cost?.totals.costUsdEstimate ?? 0;
  const label = loading && !cost ? "…" : formatUsd(amount);
  const className =
    "border-b border-dashed border-fg-faint text-2xl font-medium text-fg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong";

  if (!toggleable) {
    return (
      <span className={className} title="This agent — all sessions in window">
        {label}
      </span>
    );
  }

  // Toggleable variant: clicking the big number opens or closes the
  // top-sessions table below. Hover tooltip is intentionally tiny so the
  // detailed breakdown lives in one place — inside the expanded view.
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="agent-cost-top-sessions"
      className={`${className} cursor-pointer hover:text-fg`}
      title={open ? "Hide top sessions" : "Show top sessions"}
      data-testid="agent-cost-big-toggle"
    >
      {label}
    </button>
  );
}

/**
 * Sparkline with per-day hover tooltip. On mouse move, the closest
 * day-bucket is highlighted with a circle marker; an absolutely-
 * positioned label above the cursor shows the date and that day's
 * cost. The container is relatively positioned so the tooltip anchors
 * against the sparkline width.
 */
function Sparkline({
  byDay,
  path,
}: {
  byDay: AgentCost["byDay"];
  path: string;
}) {
  const sorted = useMemo(
    () => byDay.slice().sort((a, b) => a.day.localeCompare(b.day)),
    [byDay],
  );
  const max = useMemo(
    () => Math.max(...sorted.map((d) => d.costUsdEstimate), 1e-9),
    [sorted],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number>(0);

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el || sorted.length === 0) return;
    const rect = el.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const ratio = Math.min(Math.max(xPx / rect.width, 0), 1);
    const idx =
      sorted.length === 1
        ? 0
        : Math.round(ratio * (sorted.length - 1));
    setHoverIdx(idx);
    setHoverX(xPx);
  };

  const onMouseLeave = () => setHoverIdx(null);

  const hovered = hoverIdx !== null ? sorted[hoverIdx] : null;
  // SVG x for the hovered point in the 0..200 viewBox.
  const hoveredSvgX =
    hoverIdx !== null && sorted.length > 1
      ? (hoverIdx / (sorted.length - 1)) * 200
      : 0;
  const hoveredSvgY =
    hovered != null ? 40 - (hovered.costUsdEstimate / max) * 32 - 4 : 0;

  return (
    <div
      ref={containerRef}
      className="relative mt-2"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <svg
        className="w-full"
        viewBox="0 0 200 40"
        preserveAspectRatio="none"
        height={40}
        aria-label="Daily cost sparkline"
      >
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hovered ? (
          <>
            <line
              x1={hoveredSvgX}
              x2={hoveredSvgX}
              y1={0}
              y2={40}
              stroke="var(--color-fg-faint)"
              strokeWidth={0.5}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={hoveredSvgX}
              cy={hoveredSvgY}
              r={2.5}
              fill="var(--color-accent)"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
      </svg>
      {hovered ? (
        <div
          className="pointer-events-none absolute -top-1 z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border-strong bg-surface-elevated px-2 py-1 text-[11px] text-fg shadow-lg"
          style={{ left: hoverX }}
          data-testid="sparkline-day-tooltip"
        >
          <span className="text-fg-faint">{formatDayShort(hovered.day)}</span>
          <span className="ml-2 font-medium">
            {formatUsd(hovered.costUsdEstimate)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function formatDayShort(day: string): string {
  // day is "YYYY-MM-DD"; render as "May 10" using the browser's locale.
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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
