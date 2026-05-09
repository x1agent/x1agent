import type { SessionDTO } from "@x1agent/shared";
import type { ChildRef } from "../../stores/sessionDetailStore";

/**
 * Re-exported under a UI-friendly name so feature callers don't have
 * to reach into the store package for the row shape. The two names
 * are intentionally identical structurally — this is the same record
 * the store ships.
 */
export type ChildWorker = ChildRef;

const ACTIVE_STATUSES: ReadonlyArray<SessionDTO["status"]> = [
  "pending",
  "running",
];

/**
 * Number of children that are still doing work — i.e. would count as
 * "running" in a CEO-style status banner. `complete` and `failed`
 * children belong in history, not in the live counter.
 */
export function countActiveWorkers(children: ReadonlyArray<ChildWorker>): number {
  let n = 0;
  for (const c of children) {
    if (ACTIVE_STATUSES.includes(c.status)) n += 1;
  }
  return n;
}

/**
 * The compact label shown next to the prompt composer. Mirrors
 * Claude Code's "N tasks running" affordance: empty-state copy when
 * nothing is in flight; precise singular/plural otherwise.
 */
export function formatWorkersLabel(activeCount: number): string {
  if (activeCount <= 0) return "No active workers";
  if (activeCount === 1) return "1 child session running";
  return `${activeCount} child sessions running`;
}

/**
 * Order children for display in the flyout: active first (so what the
 * operator most likely wants to click is at the top), then by most
 * recently triggered. Stable enough for the "click to drill in" path
 * that the brief asks for.
 */
export function sortChildrenForFlyout(
  children: ReadonlyArray<ChildWorker>,
): ChildWorker[] {
  return [...children].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.includes(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.includes(b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    // Most recent first within each bucket.
    return b.triggered_at.localeCompare(a.triggered_at);
  });
}
