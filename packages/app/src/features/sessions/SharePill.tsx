import { FileText } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { useArtifactPanelStore } from "../../stores/artifactPanelStore";
import { TYPE_ICONS, formatSize, type AgentSharePayload } from "./ShareCard";

interface Props {
  event: SessionEventDTO;
  workspaceSlug: string;
  sessionId: string;
}

/**
 * Single-row pill rendering of an `agent.share` event. Replaces the
 * inline ShareCard preview in the chat stream — clicking opens the
 * share in the right-rail ArtifactPanel.
 *
 * Cost in the stream: ~3 DOM nodes per pill, regardless of share type.
 * The heavy viewer (iframe / JsonView / Markdown / table) only mounts
 * inside ArtifactPanel when the user actually opens it, and only one
 * is mounted at a time.
 */
export function SharePill({ event, workspaceSlug, sessionId }: Props) {
  const payload = (event.payload ?? {}) as AgentSharePayload;
  const show = useArtifactPanelStore((s) => s.show);
  const open = useArtifactPanelStore((s) => s.open);

  if (!payload.share_id) return null;

  const Icon = TYPE_ICONS[payload.share_type] ?? FileText;
  const isOpen =
    open?.artifact.share_id === payload.share_id &&
    open?.sessionId === sessionId;

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() =>
          show({ workspaceSlug, sessionId, artifact: payload })
        }
        className={
          "group inline-flex max-w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition " +
          (isOpen
            ? "border-border-strong bg-bg-elevated text-fg"
            : "border-border-soft bg-bg text-fg-muted hover:border-border-soft hover:bg-bg-elevated")
        }
      >
        <Icon className="size-3.5 shrink-0 text-fg-muted" />
        <span className="truncate font-medium">{payload.title}</span>
        <span className="shrink-0 rounded bg-bg-muted/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
          {payload.share_type}
        </span>
        <span className="shrink-0 text-[11px] text-fg-faint">
          {formatSize(payload.total_size)}
        </span>
      </button>
    </div>
  );
}
