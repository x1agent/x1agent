import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  formatTokens,
  formatUsd,
  useCostStore,
  type SessionCost,
  type SessionTreeCost,
  type TokenUsageByModel,
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
 *   This session [●] $2.10                                    (no children)
 *   This session [●] $2.10  +  $1.20  =  $3.30                  ▸  (with children)
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
  const selfByModel: TokenUsageByModel[] = useMemo(
    () =>
      (treeCost?.parent.byModel ?? sessionCost?.byModel ?? []) as TokenUsageByModel[],
    [treeCost, sessionCost],
  );

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

  return (
    <div
      className="rounded-md border border-border-soft bg-surface-muted/40 px-3 py-2"
      data-testid="session-cost-block"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-fg-faint">This session</span>
        {live ? (
          <span
            className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400"
            aria-label="live"
            title="Live · updates within ~2s"
          />
        ) : null}
        <CostAmount
          amount={selfCost}
          byModel={selfByModel}
          live={live}
        />
        {hasChildren && treeCost ? (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              +
            </span>
            <WorkerCostAmount
              amount={workerTotal}
              count={workerCount}
              workers={treeCost.children}
              workspaceSlug={workspaceSlug}
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
          className="mt-2 border-t border-border-soft/60 pt-2"
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
 * Hover (or keyboard focus) reveals a tooltip with the per-model token
 * breakdown — locked by the greenlit mockup. Implemented as a native
 * CSS-only tooltip using `details/summary` would change the keyboard
 * model; we keep it as a span with a sibling popover sized via Tailwind
 * to stay consistent with other inline tooltips in the app.
 */
export function CostAmount({
  amount,
  byModel,
  live,
}: {
  amount: number;
  byModel: TokenUsageByModel[];
  live: boolean;
}) {
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
        className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden min-w-[18rem] rounded-md border border-border-strong bg-surface-elevated px-3 py-2 text-xs text-fg shadow-lg group-hover:block group-focus-within:block"
      >
        <div className="mb-1 font-medium text-fg">
          This session — cost breakdown by model
        </div>
        <div className="mb-2 border-t border-border-soft" />
        {byModel.length === 0 ? (
          <div className="text-fg-faint">No model usage yet</div>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <tbody>
              {byModel.map((m) => (
                <ModelRow key={m.model} m={m} />
              ))}
              <tr className="border-t border-border-soft">
                <td className="pt-1 text-fg-faint">Total</td>
                <td className="pt-1 text-right font-medium">
                  {formatUsd(amount)}
                </td>
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
 * Inline summary of worker costs sitting between the "this session"
 * amount and the grand total. Hover/focus reveals which workers
 * contributed — same dashed-underline affordance as the by-model
 * tooltip on `CostAmount`.
 */
export function WorkerCostAmount({
  amount,
  count,
  workers,
  workspaceSlug,
}: {
  amount: number;
  count: number;
  workers: SessionTreeCost["children"];
  workspaceSlug: string;
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
        className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden min-w-[18rem] rounded-md border border-border-strong bg-surface-elevated px-3 py-2 text-xs text-fg shadow-lg group-hover:block group-focus-within:block"
      >
        <div className="mb-1 font-medium text-fg">Across {label}</div>
        <div className="mb-2 border-t border-border-soft" />
        <ul className="space-y-1">
          {workers.map((w) => (
            <li
              key={w.sessionId}
              className="flex min-w-0 items-center gap-2"
            >
              <a
                href={`/workspaces/${workspaceSlug}/sessions/${w.sessionId}`}
                className="truncate text-fg-muted hover:underline"
                title={w.summary ?? w.sessionId}
              >
                {w.agentName ?? "worker"} {w.sessionId.slice(0, 8)}…
              </a>
              <span className="ml-auto shrink-0 text-fg">
                {formatUsd(w.costUsdEstimate)}
              </span>
            </li>
          ))}
        </ul>
      </span>
    </span>
  );
}

function ModelRow({ m }: { m: TokenUsageByModel }) {
  return (
    <>
      <tr>
        <td className="font-mono">{m.model}</td>
        <td className="text-right">{formatUsd(m.costUsdEstimate)}</td>
      </tr>
      <tr className="text-fg-faint">
        <td className="pl-3">input tokens</td>
        <td className="text-right">{formatTokens(m.inputTokens)}</td>
      </tr>
      <tr className="text-fg-faint">
        <td className="pl-3">output tokens</td>
        <td className="text-right">{formatTokens(m.outputTokens)}</td>
      </tr>
      <tr className="text-fg-faint">
        <td className="pl-3">cache reads</td>
        <td className="text-right">
          {formatTokens(m.cacheReadInputTokens)}
        </td>
      </tr>
      <tr className="text-fg-faint">
        <td className="pl-3">cache writes</td>
        <td className="text-right">
          {formatTokens(m.cacheCreationInputTokens)}
        </td>
      </tr>
    </>
  );
}
