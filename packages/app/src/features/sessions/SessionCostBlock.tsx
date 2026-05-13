import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  formatUsd,
  useCostStore,
  type SessionCost,
  type SessionTreeCost,
} from "../../stores/costStore";

interface Props {
  workspaceSlug: string;
  sessionId: string;
  /**
   * Whether this session is the live one being watched (Views 1+2).
   * The pulsing green dot only shows on live sessions; the tree
   * aggregate and the agent rollup omit it (locked by the greenlit
   * mockup: "Live-dot — pulsing green dot on 'this session' cost
   * only").
   */
  live: boolean;
  /**
   * Last seq from the session-event stream. Bumps trigger a refetch
   * so the cost block updates within ~2s of a tool/LLM emission. The
   * acceptance criterion is "updates within seconds", so a tiny
   * debounce window keeps us from POST-ing per token.
   */
  lastEventSeq: number;
}

/**
 * Combined View 1 + View 2 — header-mounted cost block on the session
 * detail page. Renders, in collapsed (default) form:
 *
 *   Cost [●] $2.10                                    (no children)
 *   Cost [●] $2.10  +  $1.20  =  $3.30                  ▸  (with children)
 *
 * Each dashed-underlined amount opens a tooltip on hover/focus: the
 * "this session" amount shows the per-model breakdown; the workers sum
 * shows which workers contributed and how many. Clicking the caret on
 * the right expands the full tree inline below the pill.
 *
 * Locked decisions (greenlit mockup, 2026-05-12):
 *   - Muted dollar amount + dashed underline as the hover-affordance.
 *     Not an ⓘ icon, not always-visible.
 *   - Pulsing green live-dot on "this session" only (not on the tree
 *     aggregate row or any per-child row).
 *   - Tree breakdown inline under the cost block — not in a separate
 *     "Cost" tab (which would bury the answer to the question).
 *   - Tree is collapsed by default (X1A-116). The headline math
 *     (session + workers = total) is the answer most of the time; the
 *     per-worker rows are one click away. State is per-session and does
 *     not persist across reloads.
 */
export function SessionCostBlock({
  workspaceSlug,
  sessionId,
  live,
  lastEventSeq,
}: Props) {
  const loadSessionCost = useCostStore((s) => s.loadSessionCost);
  const loadSessionTreeCost = useCostStore((s) => s.loadSessionTreeCost);

  const sessionCost = useCostStore(
    (s) => s.sessionCostBySession[sessionId],
  ) as SessionCost | undefined;
  const treeCost = useCostStore(
    (s) => s.treeCostBySession[sessionId],
  ) as SessionTreeCost | undefined;

  // Debounce-by-seq: re-fetch each time a new event lands, but coalesce
  // bursts using a short delay. Tools that emit ten events in a tight
  // turn shouldn't fire ten parallel cost fetches.
  useEffect(() => {
    void loadSessionCost(workspaceSlug, sessionId);
    void loadSessionTreeCost(workspaceSlug, sessionId);
  }, [workspaceSlug, sessionId, loadSessionCost, loadSessionTreeCost]);

  useEffect(() => {
    if (lastEventSeq === 0) return;
    const t = setTimeout(() => {
      void loadSessionCost(workspaceSlug, sessionId);
      void loadSessionTreeCost(workspaceSlug, sessionId);
    }, 750);
    return () => clearTimeout(t);
  }, [
    lastEventSeq,
    workspaceSlug,
    sessionId,
    loadSessionCost,
    loadSessionTreeCost,
  ]);

  // The "this session" amount comes from /cost. The tree breakdown
  // comes from /cost-tree. /cost-tree returns the parent's own cost
  // too, so once tree is loaded we prefer its parent over /cost for
  // consistency — they query the same rows but reading from one
  // payload avoids a fraction-of-a-second mismatch during refetch.
  const selfCost = treeCost?.parent.totals.costUsdEstimate
    ?? sessionCost?.totals.costUsdEstimate
    ?? 0;

  const hasChildren = (treeCost?.children?.length ?? 0) > 0;
  const treeTotal = treeCost?.totals.costUsdEstimate ?? selfCost;
  const workerCount = treeCost?.children.length ?? 0;
  const workerTotal = useMemo(
    () =>
      (treeCost?.children ?? []).reduce(
        (acc, c) => acc + c.costUsdEstimate,
        0,
      ),
    [treeCost],
  );

  // Collapsed-by-default per X1A-116. State is per-session via React
  // local state — toggling on one session view doesn't affect siblings,
  // and the collapsed state resets on reload (the desired default).
  const [treeOpen, setTreeOpen] = useState(false);
  const treeId = useId();
  const ChevronIcon = treeOpen ? ChevronDown : ChevronRight;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the floating tree on outside click or Escape. Listener is
  // only attached while the dropdown is open so we don't pay for every
  // session in the page that isn't expanded.
  useEffect(() => {
    if (!treeOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (e.target instanceof Node && !root.contains(e.target)) {
        setTreeOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTreeOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [treeOpen]);

  return (
    <div
      ref={rootRef}
      className="relative rounded-md border border-border-soft bg-surface-muted/40 px-3 py-2"
      data-testid="session-cost-block"
    >
      <div className="flex items-center gap-2 whitespace-nowrap text-xs">
        <span className="text-fg-faint">Cost</span>
        {live ? (
          <span
            className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400"
            aria-label="live"
            title="Live · updates within ~2s"
          />
        ) : null}
        <CostAmount amount={selfCost} />
        {hasChildren && treeCost ? (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              +
            </span>
            <WorkerCostAmount
              amount={workerTotal}
              count={workerCount}
            />
            <span aria-hidden="true" className="text-fg-faint">
              =
            </span>
            <span
              className="font-medium text-fg"
              data-testid="session-tree-grand-total"
            >
              {formatUsd(treeTotal)}
            </span>
            <button
              type="button"
              onClick={() => setTreeOpen((v) => !v)}
              aria-expanded={treeOpen}
              aria-controls={treeId}
              aria-label={
                treeOpen ? "Collapse session tree" : "Expand session tree"
              }
              className="ml-auto inline-flex items-center rounded text-fg-muted hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
              data-testid="session-tree-toggle"
            >
              <ChevronIcon className="size-3" />
            </button>
          </>
        ) : null}
      </div>

      {hasChildren && treeCost && treeOpen ? (
        <div
          id={treeId}
          className="absolute right-0 top-full z-30 mt-1 w-[22rem] max-w-[90vw] rounded-md border border-border-strong bg-surface-elevated px-3 py-2 shadow-lg"
        >
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-faint">
            Session tree
          </div>
          <ul className="space-y-0.5 text-xs">
            <li className="flex items-center gap-2 font-mono text-fg-muted">
              <span className="text-fg-faint">└─ self</span>
              <span className="ml-auto">{formatUsd(selfCost)}</span>
            </li>
            {treeCost.children.map((c) => (
              <li
                key={c.sessionId}
                className="flex min-w-0 items-center gap-2 font-mono text-fg-muted"
                style={{ paddingLeft: `${Math.min(c.depth, 6) * 12}px` }}
              >
                <span className="text-fg-faint">└─</span>
                <a
                  href={`/workspaces/${workspaceSlug}/sessions/${c.sessionId}`}
                  className="truncate hover:underline"
                  title={c.summary ?? c.sessionId}
                >
                  {c.agentName ?? "worker"} {c.sessionId.slice(0, 8)}…
                </a>
                <span className="ml-auto shrink-0">
                  {formatUsd(c.costUsdEstimate)}
                </span>
              </li>
            ))}
            <li className="mt-1 flex items-center gap-2 border-t border-border-soft/40 pt-1 text-xs">
              <span className="text-fg-faint">Total</span>
              <span className="ml-auto font-medium text-fg">
                {formatUsd(treeTotal)}
              </span>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The muted dollar amount with dashed-underline hover affordance.
 * Hover (or keyboard focus) reveals a short label clarifying that this
 * is the current session's cost — the full per-worker breakdown lives
 * inside the floating tree dropdown one click away on the caret.
 */
export function CostAmount({ amount }: { amount: number }) {
  return (
    <span className="group relative inline-flex items-center">
      <span
        className="cursor-help border-b border-dashed border-fg-faint text-fg-muted"
        tabIndex={0}
        aria-describedby="cost-tooltip"
      >
        {formatUsd(amount)}
      </span>
      <span
        id="cost-tooltip"
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden whitespace-nowrap rounded-md border border-border-strong bg-surface-elevated px-2 py-1 text-xs text-fg shadow-lg group-hover:block group-focus-within:block"
      >
        This session
      </span>
    </span>
  );
}

/**
 * Inline summary of worker costs sitting between the "this session"
 * amount and the grand total. Hover/focus reveals which workers
 * contributed — same dashed-underline affordance as the by-model
 * tooltip on `CostAmount`.
 */
export function WorkerCostAmount({
  amount,
  count,
}: {
  amount: number;
  count: number;
}) {
  const label = `${count} ${count === 1 ? "worker" : "workers"}`;
  return (
    <span className="group relative inline-flex items-center">
      <span
        className="cursor-help border-b border-dashed border-fg-faint text-fg-muted"
        tabIndex={0}
        aria-describedby="workers-cost-tooltip"
        aria-label={`Workers cost — ${label}`}
      >
        {formatUsd(amount)}
      </span>
      <span
        id="workers-cost-tooltip"
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden whitespace-nowrap rounded-md border border-border-strong bg-surface-elevated px-2 py-1 text-xs text-fg shadow-lg group-hover:block group-focus-within:block"
      >
        Across {label}
      </span>
    </span>
  );
}

