import { useEffect, useState } from "react";
import { FileText, MessageSquare } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { useArtifactPanelStore } from "../../stores/artifactPanelStore";
import {
  useShareCommentsStore,
  groupThreads,
  unresolvedThreadCount,
} from "../../stores/shareCommentsStore";
import { useAuthStore } from "../../stores/authStore";
import { TYPE_ICONS, formatSize, type AgentSharePayload } from "./ShareCard";
import { CommentBody } from "./CommentBody";

// Stable module-level empty array — see CLAUDE.md "Frontend state management"
// selector foot-gun rule. Returning a fresh `[]` inside a zustand selector
// makes useSyncExternalStore detect "changed" on every render and triggers
// an infinite update loop (React error #185 / Maximum update depth).
const EMPTY_ROWS: never[] = [];

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
  const maximize = useArtifactPanelStore((s) => s.maximize);
  const open = useArtifactPanelStore((s) => s.open);

  const isCommentable = COMMENTABLE_TYPES.has(payload.share_type);
  const rows = useShareCommentsStore(
    (s) => s.byShareId[payload.share_id] ?? EMPTY_ROWS,
  );
  const loadComments = useShareCommentsStore((s) => s.load);

  // Lazy-load comments on first mount for a commentable share.
  //
  // Use the EVENT's session_id (the session where the share was
  // emitted) rather than the page's sessionId prop. When a resumed
  // session inlines its parent's stream, the page renders SharePills
  // for shares whose share_id only exists on the parent — fetching
  // those at the child's URL yields 404 from findShareInSession.
  // event.session_id always points at the originating session.
  const originSessionId = event.session_id ?? sessionId;
  useEffect(() => {
    if (!isCommentable || !payload.share_id) return;
    loadComments({
      workspaceSlug,
      sessionId: originSessionId,
      shareId: payload.share_id,
    });
  }, [
    isCommentable,
    payload.share_id,
    workspaceSlug,
    originSessionId,
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
    <div className="py-1" data-share-id={payload.share_id}>
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
        {isCommentable &&
          (unresolved > 0 ? (
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
          ) : (
            // Zero-state entry — always present on commentable shares so
            // the first thread has somewhere to come from in the UI.
            // Drives state through the zustand store (show + maximize)
            // rather than navigating to a URL; the store's syncUrl
            // side effect writes ?share=…&mode=fullscreen to the URL
            // so the result is still copy-paste shareable.
            <button
              type="button"
              onClick={() => {
                show({ workspaceSlug, sessionId: originSessionId, artifact: payload });
                maximize();
              }}
              aria-label="Start a comment thread on this share"
              title="Comment on this share"
              className={
                "ml-1 inline-flex shrink-0 items-center justify-center rounded-[4px] px-1.5 py-0.5 text-fg-faint hover:bg-bg-elevated hover:text-fg-muted"
              }
              data-testid="comment-zero-entry"
            >
              <MessageSquare className="size-3.5" />
            </button>
          ))}
      </div>
      {expanded && threads.length > 0 && (
        <ThreadSnippetsConnected
          threads={threads}
          shareType={payload.share_type}
          onExpandFullscreen={() => {
            show({ workspaceSlug, sessionId: originSessionId, artifact: payload });
            maximize();
          }}
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
function ThreadSnippetsConnected(props: {
  threads: ReturnType<typeof groupThreads>;
  shareType: string;
  onExpandFullscreen: () => void;
}) {
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  return <ThreadSnippets {...props} currentUserId={currentUserId} />;
}

function ThreadSnippets({
  threads,
  shareType,
  onExpandFullscreen,
  currentUserId,
}: {
  threads: ReturnType<typeof groupThreads>;
  shareType: string;
  onExpandFullscreen: () => void;
  currentUserId: string | null;
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
        const isSelf =
          !!currentUserId &&
          latest.author_user_id != null &&
          latest.author_user_id === currentUserId;
        return (
          <div
            key={t.thread_id}
            className={
              "px-2.5 py-1.5 text-[13px] " +
              (i > 0 ? "mt-1 border-t border-border-soft pt-2.5" : "")
            }
            data-self={isSelf ? "true" : "false"}
          >
            {t.scope === "passage" && t.anchor?.selection.quoted_text && (
              // Passage-anchored: the quoted source text tells the reader
              // which span the thread is about. Share-scoped comments
              // (HTML and unanchored markdown) skip this header — the
              // surrounding pill is sufficient context.
              <blockquote className="mb-1 border-l-2 border-border-soft pl-2 text-[12px] italic text-fg-faint">
                {t.anchor.selection.quoted_text}
              </blockquote>
            )}
            <div
              className={`leading-snug text-fg ${
                isSelf ? "flex flex-col items-end" : ""
              }`}
            >
              <span
                className={`mr-1.5 font-semibold text-fg-muted ${
                  isSelf ? "self-end" : ""
                }`}
              >
                {snippetAuthor(latest, currentUserId)}
              </span>
              <div
                className={
                  isSelf
                    ? "max-w-[85%] rounded-2xl bg-bg-elevated/70 px-3 py-1.5"
                    : ""
                }
              >
                {/* Snippet preview keeps its inline, one-shot 240-char
                    truncation. */}
                <CommentBody
                  body={
                    latest.body.length > 240
                      ? latest.body.slice(0, 240) + "…"
                      : latest.body
                  }
                />
              </div>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onExpandFullscreen}
        className="ml-2.5 mt-1 inline-block text-[12px] text-accent hover:opacity-90"
      >
        Open full view →
      </button>
      {/* Suppress unused-shareType lint — kept for future "On this share" / per-passage divergence beyond v1. */}
      <span hidden data-share-type={shareType} />
    </div>
  );
}

// Same identity rules as the ArtifactCommentsSidebar's formatAuthor —
// no raw uuid slices in the UI. Duplicating the four-line function
// rather than extracting until there's a third caller.
function snippetAuthor(
  c: { author_user_id: string | null; author_session_id: string | null },
  currentUserId: string | null,
): string {
  if (c.author_user_id && c.author_user_id === currentUserId) return "you";
  if (c.author_session_id) return "agent";
  if (c.author_user_id) return "someone";
  return "unknown";
}
