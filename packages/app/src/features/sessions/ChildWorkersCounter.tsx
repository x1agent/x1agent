import { useState } from "react";
import { useSessionDetailStore } from "../../stores/sessionDetailStore";
import { ChildWorkersFlyout } from "./ChildWorkersFlyout";
import {
  countActiveWorkers,
  formatWorkersLabel,
  type ChildWorker,
} from "./childWorkers";

interface Props {
  workspaceSlug: string;
  sessionId: string;
}

/**
 * Compact status pill anchored next to the prompt composer. Mirrors
 * Claude Code's "N tasks running" affordance: a muted underline-link
 * label that opens a flyout listing each child session.
 *
 * Real-time: pulls `childrenBySession[sessionId]` straight off the
 * shared zustand store, so any update there (initial load, future
 * spawn/complete events appended via `appendEvent`) re-renders the
 * counter and the flyout in lockstep. No internal polling.
 */
export function ChildWorkersCounter({ workspaceSlug, sessionId }: Props) {
  // Pull the slot raw (no ??-inside-selector) so the same reference
  // is returned on each render until the store actually mutates the
  // entry — see imagesStore.test.ts for the rationale.
  const slot = useSessionDetailStore(
    (s) => s.childrenBySession[sessionId],
  );
  const children: ChildWorker[] = slot ?? EMPTY;
  const [open, setOpen] = useState(false);

  const activeCount = countActiveWorkers(children);
  const label = formatWorkersLabel(activeCount);

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="text-[12px] text-fg-faint underline decoration-dotted underline-offset-2 transition hover:text-fg-muted"
        data-testid="child-workers-counter"
      >
        {label}
      </button>
      <ChildWorkersFlyout
        workspaceSlug={workspaceSlug}
        open={open}
        onClose={() => setOpen(false)}
        workers={children}
      />
    </div>
  );
}

// Stable empty array reference so the selector returns === across
// renders when no children exist — protects against React's render-
// bailout heuristic noted in CLAUDE.md / imagesStore.test.ts.
const EMPTY: ChildWorker[] = [];
