import { useEffect } from "react";
import { Download, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { useArtifactPanelStore } from "../../stores/artifactPanelStore";
import {
  TYPE_ICONS,
  formatSize,
  renderShareBody,
  shareUrl,
  type AgentSharePayload,
  type ShareType,
} from "./ShareCard";

const FULLSCREEN_TYPES: ShareType[] = ["site", "csv", "json", "document"];

/**
 * Right-rail artifact viewer. Mounted once in SessionRoot, but the
 * heavy renderer body only mounts when the store has an open artifact.
 *
 * Two visual modes:
 *   • panel       — fixed-width column docked to the right of the
 *                   chat. Default state. Maximize button promotes it.
 *   • fullscreen  — overlay over the whole viewport. Esc closes.
 *
 * Reuses the same per-share-type renderers as the legacy ShareCard
 * (now exported from that file) so artifact rendering stays single-
 * sourced. Switching to a new artifact replaces the renderer subtree;
 * old viewer state (scroll, fetched bytes) is dropped.
 */
export function ArtifactPanel() {
  const open = useArtifactPanelStore((s) => s.open);
  const view = useArtifactPanelStore((s) => s.view);
  const close = useArtifactPanelStore((s) => s.close);
  const maximize = useArtifactPanelStore((s) => s.maximize);
  const restore = useArtifactPanelStore((s) => s.restore);

  // Esc closes (in panel) or restores (in fullscreen). Hook always
  // mounted so the listener gets cleaned up when `open` toggles —
  // moving it inside the conditional return below would skip cleanup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!open) return;
      if (view === "fullscreen") restore();
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, view, close, restore]);

  if (!open) return null;

  const { artifact, workspaceSlug, sessionId } = open;
  return (
    <ArtifactSurface view={view} onClose={close}>
      <ArtifactHeader
        artifact={artifact}
        workspaceSlug={workspaceSlug}
        sessionId={sessionId}
        view={view}
        onMaximize={maximize}
        onRestore={restore}
        onClose={close}
      />
      <div className="flex-1 overflow-auto p-4">
        {renderShareBody({
          payload: artifact,
          workspaceSlug,
          sessionId,
          maximized: view === "fullscreen",
        })}
      </div>
    </ArtifactSurface>
  );
}

function ArtifactSurface({
  view,
  onClose,
  children,
}: {
  view: "panel" | "fullscreen";
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (view === "fullscreen") {
    return (
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-50 flex flex-col bg-bg"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {children}
      </div>
    );
  }
  // Panel mode: docked to the right of the chat column. Width is held
  // here rather than in SessionRoot so the rail moves as one piece.
  return (
    <aside
      aria-label="Artifact"
      className="surface-card flex h-full w-[480px] shrink-0 flex-col overflow-hidden"
    >
      {children}
    </aside>
  );
}

function ArtifactHeader({
  artifact,
  workspaceSlug,
  sessionId,
  view,
  onMaximize,
  onRestore,
  onClose,
}: {
  artifact: AgentSharePayload;
  workspaceSlug: string;
  sessionId: string;
  view: "panel" | "fullscreen";
  onMaximize: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const Icon = TYPE_ICONS[artifact.share_type];
  const downloadPath =
    artifact.entry_point || artifact.files[0]?.path || "";
  const downloadUrl = shareUrl(
    workspaceSlug,
    sessionId,
    artifact.share_id,
    downloadPath,
  );
  const canMaximize =
    FULLSCREEN_TYPES.includes(artifact.share_type) || view === "fullscreen";
  const isMaximized = view === "fullscreen";

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-3">
      <Icon className="size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">
          {artifact.title}
        </div>
        <div className="text-[11px] text-fg-faint">
          {artifact.share_type}
          {" · "}
          {formatSize(artifact.total_size)}
          {artifact.files.length > 1 && ` · ${artifact.files.length} files`}
        </div>
      </div>
      <a href={downloadUrl} download target="_blank" rel="noopener">
        <Button variant="ghost" size="sm" title="Download">
          <Download className="size-3.5" />
        </Button>
      </a>
      {artifact.share_type === "site" && (
        <a href={downloadUrl} target="_blank" rel="noopener">
          <Button variant="ghost" size="sm" title="Open in new tab">
            <ExternalLink className="size-3.5" />
          </Button>
        </a>
      )}
      {canMaximize && (
        <Button
          variant="ghost"
          size="sm"
          onClick={isMaximized ? onRestore : onMaximize}
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        aria-label="Close artifact"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
