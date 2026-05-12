import { useEffect, useState } from "react";
import { FileText, MessageSquare } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { useArtifactPanelStore } from "../../stores/artifactPanelStore";
import {
  useShareCommentsStore,
  groupThreads,
  unresolvedThreadCount,
} from "../../stores/shareCommentsStore";
import { TYPE_ICONS, formatSize, type AgentSharePayload } from "./ShareCard";

interface Props {
  event: SessionEventDTO;
  workspaceSlug: string;
  sessionId: string;
}

/**
 * Single-row pill rendering of an `agent.share` event. X1A-53 — for
 * markdown (`document`) and HTML (`site`) shares, surface the comment
 * count as an accent-soft chip to the right of the type-badge. Clicking
 * the chip toggles an inline snippet preview of the most recent 1–3
 * threads; clicking the pill body opens the share in the right-rail
 * ArtifactPanel as before.
 *
 * Visual contract: see doc-commenting-mockup-v3.html § View 1 — chip is
 * `bg-accent-soft text-accent rounded-[4px] px-1.5 py-0.5 text-[11px]`
 * with `MessageSquare` lucide icon. Inline snippets sit in a card with
 * an accent-soft left border + faint gradient.
 */
const COMMENTABLE_TYPES = new Set(["document", "site"]);

export function SharePill({ event, workspaceSlug, sessionId }: Props) {
  const payload = (event.payload ?? {}) as AgentSharePayload;
  const show = useArtifactPanelStore((s) => s.show);
  const open = useArtifactPanelStore((s) => s.open);

  const isCommentable = COMMENTABLE_TYPES.has(payload.share_type);
  const rows = useShareCommentsStore(
    (s) => s.byShareId[payload.share_id] ?? [],
  );
  const loadComments = useShareCommentsStore((s) => s.load);

  // Lazy-load comments on first mount for a commentable share. Cheap
  // — the GET is a single indexed query — and it lets the chip count
  // appear without a click.
  useEffect(() => {
    if (!isCommentable || !payload.share_id) return;
    loadComments({ workspaceSlug, sessionId, shareId: payload.share_id });
  }, [
    isCommentable,
    payload.share_id,
    workspaceSlug,
    sessionId,
    loadComments,
  ]);

  const [expanded, setExpanded] = useState(false);

  if (!payload.share_id) return null;

  const Icon = TYPE_ICONS[payload.share_type] ?? FileText;
  const isOpen =
    open?.artifact.share_id === payload.share_id &&
    open?.sessionId === sessionId;

  const unresolved = unresolvedThreadCount(rows);
  const threads = groupThreads(rows).slice(0, 3);

  return (
    <div className="py-1">
      <div
        className={
          "group inline-flex max-w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition " +
          (isOpen
            ? "border-border-strong bg-bg-elevated text-fg"
            : "border-border-soft bg-bg text-fg-muted hover:border-border-soft hover:bg-bg-elevated")
        }
      >
        <button
          type="button"
          onClick={() =>
            show({ workspaceSlug, sessionId, artifact: payload })
          }
          className="inline-flex min-w-0 items-center gap-2 text-left"
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
        {isCommentable && unresolved > 0 && (
          <button
            type="button"
            aria-label={`${unresolved} comment${unresolved === 1 ? "" : "s"}`}
            onClick={() => setExpanded((v) => !v)}
            className={
              "ml-1 inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
              "bg-accent-soft text-accent hover:opacity-90"
            }
            data-testid="comment-chip"
          >
            <MessageSquare className="size-3" />
            {unresolved} {unresolved === 1 ? "comment" : "comments"}
          </button>
        )}
      </div>
      {expanded && threads.length > 0 && (
        <ThreadSnippets
          threads={threads}
          shareType={payload.share_type}
          fullscreenHref={`/workspaces/${workspaceSlug}/sessions/${sessionId}/shares/${payload.share_id}/fullscreen`}
        />
      )}
    </div>
  );
}

/**
 * Inline preview of the most-recent threads on a share. Matches mockup
 * v3 § View 1: accent-soft left border, faint gradient, italic anchor
 * quote (or "On this share" sublabel for HTML), latest-reply preview,
 * "See all in fullscreen →" link at the bottom.
 */
function ThreadSnippets({
  threads,
  shareType,
  fullscreenHref,
}: {
  threads: ReturnType<typeof groupThreads>;
  shareType: string;
  fullscreenHref: string;
}) {
  return (
    <div
      className="mt-1.5 ml-3.5 rounded-r-md border-l-2 border-accent-soft py-2 pl-3.5"
      style={{
        background:
          "linear-gradient(90deg, var(--color-accent-soft, rgba(194,97,62,0.12)), transparent 60%)",
      }}
      data-testid="thread-snippets"
    >
      {threads.map((t, i) => {
        const latest = t.comments[t.comments.length - 1]!;
        return (
          <div
            key={t.thread_id}
            className={
              "px-2.5 py-1.5 text-[13px] " +
              (i > 0 ? "mt-1 border-t border-border-soft pt-2.5" : "")
            }
          >
            {t.scope === "passage" && t.anchor?.selection.quoted_text ? (
              <div className="mb-1 border-b border-dotted border-border-soft pb-1 text-[12px] italic text-fg-faint">
                "{t.anchor.selection.quoted_text}"
              </div>
            ) : (
              <div className="mb-1 border-b border-dotted border-border-soft pb-1 text-[11px] uppercase tracking-wide text-fg-faint">
                On this share
              </div>
            )}
            <div className="leading-snug text-fg">
              <span className="mr-1.5 font-semibold text-fg-muted">
                {latest.author_user_id
                  ? latest.author_user_id.slice(0, 6)
                  : latest.author_session_id
                    ? "agent"
                    : "unknown"}
              </span>
              {latest.body.length > 240
                ? latest.body.slice(0, 240) + "…"
                : latest.body}
            </div>
          </div>
        );
      })}
      <a
        href={fullscreenHref}
        className="ml-2.5 mt-1 inline-block text-[12px] text-accent hover:opacity-90"
      >
        See all{" "}
        {threads.length === 1 ? "thread" : `${threads.length}+ threads`} in
        fullscreen →
      </a>
      {/* Suppress unused-shareType lint — kept for future "On this share" / per-passage divergence beyond v1. */}
      <span hidden data-share-type={shareType} />
    </div>
  );
}
