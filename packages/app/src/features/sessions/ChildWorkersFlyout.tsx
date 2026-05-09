import { ExternalLink, X } from "lucide-react";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import type { SessionStatus } from "@x1agent/shared";
import {
  sortChildrenForFlyout,
  type ChildWorker,
} from "./childWorkers";

const STATUS_VARIANT: Record<SessionStatus, BadgeVariant> = {
  pending: "secondary",
  running: "info",
  complete: "success",
  failed: "danger",
};

interface Props {
  workspaceSlug: string;
  open: boolean;
  onClose: () => void;
  /**
   * The list to render. Named `workers` rather than `children` to
   * avoid colliding with React's reserved `children` slot when
   * passing as a JSX prop.
   */
  workers: ReadonlyArray<ChildWorker>;
}

/**
 * Flyout listing the parent's child sessions. Shape mirrors
 * `ShareSessionPanel` (the existing share flyout): an inline overlay
 * panel with a header + close button. Rows mirror the visual rhythm
 * of the workspace sessions list — agent name + status badge + a
 * placeholder description.
 *
 * The description is the placeholder string `"Working..."` until the
 * X1A-7 LLM-summary feature lands. That ticket owns wiring real
 * descriptions; this component just leaves the slot empty-ready.
 */
export function ChildWorkersFlyout({
  workspaceSlug,
  open,
  onClose,
  workers,
}: Props) {
  if (!open) return null;
  const ordered = sortChildrenForFlyout(workers);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Child sessions"
      className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-[420px] max-w-[calc(100vw-2rem)] rounded-md border border-border-soft bg-bg shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-border-soft px-3 py-2">
        <h3 className="text-xs font-medium text-fg">Child sessions</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close child sessions flyout"
          className="text-fg-faint transition hover:text-fg-muted"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {ordered.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-fg-faint">
          No child sessions yet.
        </div>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-border-soft overflow-auto">
          {ordered.map((child) => (
            <ChildWorkerRow
              key={child.id}
              child={child}
              workspaceSlug={workspaceSlug}
              onNavigate={onClose}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChildWorkerRow({
  child,
  workspaceSlug,
  onNavigate,
}: {
  child: ChildWorker;
  workspaceSlug: string;
  onNavigate: () => void;
}) {
  const href = `/workspaces/${workspaceSlug}/sessions/${child.id}`;
  return (
    <li className="group">
      <div className="flex items-center gap-2 px-3 py-2 transition hover:bg-bg-elevated/40">
        <a
          href={href}
          onClick={onNavigate}
          className="min-w-0 flex-1"
          data-testid="child-worker-row-link"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">
              {child.agent.name}
            </span>
            <Badge variant={STATUS_VARIANT[child.status]} className="shrink-0">
              {child.status}
            </Badge>
          </div>
          {/* Placeholder description until X1A-7 ships LLM summaries.
              Kept in a fixed slot so dropping the real description in
              later doesn't shift layout. */}
          <div className="truncate text-[11px] text-fg-faint">
            Working...
          </div>
        </a>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${child.agent.name} session in new window`}
          title="Open in new window"
          className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-bg-elevated hover:text-fg-muted"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    </li>
  );
}
