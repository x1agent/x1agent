import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, MessageSquare } from "lucide-react";
import {
  useShareCommentsStore,
  groupThreads,
} from "../../stores/shareCommentsStore";
import { useArtifactPanelStore } from "../../stores/artifactPanelStore";
import { useAuthStore } from "../../stores/authStore";
import { ComposerShell } from "./ComposerShell";

// Module-level stable empty array — required to avoid the
// useSyncExternalStore foot-gun where `?? []` inside a selector
// mints a new reference on every render and triggers React error #185.
const EMPTY_ROWS: never[] = [];

const COMMENTABLE_TYPES = new Set(["document", "site"]);

interface Props {
  workspaceSlug: string;
  sessionId: string;
  shareId: string;
  shareType: string;
}

/**
 * Right-side flyout shown inside the maximized ArtifactPanel — turns
 * fullscreen artifact view into a doc-with-comments review surface.
 * Hosts the thread list + a single-line composer for adding a new
 * share-scoped comment (passage-anchored selection-to-comment is
 * deferred to X1A-65).
 *
 * All state lives in `useShareCommentsStore`; this component is a
 * presentation + form-handler shell with no useState beyond the
 * composer's draft text.
 */
export function ArtifactCommentsSidebar({
  workspaceSlug,
  sessionId,
  shareId,
  shareType,
}: Props) {
  const rows = useShareCommentsStore(
    (s) => s.byShareId[shareId] ?? EMPTY_ROWS,
  );
  const loading = useShareCommentsStore((s) => s.loading[shareId] ?? false);
  const errorMsg = useShareCommentsStore((s) => s.errors[shareId] ?? null);
  const load = useShareCommentsStore((s) => s.load);
  const add = useShareCommentsStore((s) => s.add);

  const collapsed = useArtifactPanelStore((s) => s.commentsCollapsed);
  const toggleCollapsed = useArtifactPanelStore(
    (s) => s.toggleCommentsCollapsed,
  );
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const key = useMemo(
    () => ({ workspaceSlug, sessionId, shareId }),
    [workspaceSlug, sessionId, shareId],
  );

  // Lazy-load on first mount per the design discussion — comments are
  // only fetched once the operator actually opens the fullscreen view,
  // not eagerly for every share in the stream.
  useEffect(() => {
    load(key);
  }, [load, key]);

  const threads = useMemo(() => groupThreads(rows), [rows]);

  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  if (!COMMENTABLE_TYPES.has(shareType)) return null;

  if (collapsed) {
    return (
      <aside
        aria-label="Comments (collapsed)"
        className="flex h-full w-9 shrink-0 flex-col items-center border-l border-border-soft bg-bg pt-3"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand comments"
          title="Show comments"
          className="flex flex-col items-center gap-1 rounded-md p-1.5 text-fg-faint hover:bg-bg-elevated hover:text-fg-muted"
        >
          <ChevronsLeft className="size-4" />
          <MessageSquare className="size-4" />
          {threads.length > 0 && (
            <span className="text-[10px] font-medium tabular-nums text-accent">
              {threads.length}
            </span>
          )}
        </button>
      </aside>
    );
  }

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      await add(key, { scope: "share", body });
      setDraft("");
    } finally {
      setPosting(false);
    }
  };

  return (
    <aside
      aria-label="Comments"
      className="flex h-full w-[380px] shrink-0 flex-col border-l border-border-soft bg-bg"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-3">
        <MessageSquare className="size-4 text-fg-muted" />
        <div className="min-w-0 flex-1 text-sm font-medium text-fg">
          Comments
          <span className="ml-2 text-[12px] font-normal text-fg-faint">
            {threads.length} {threads.length === 1 ? "thread" : "threads"}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Collapse comments"
          title="Hide comments"
          className="shrink-0 rounded-md p-1 text-fg-faint hover:bg-bg-elevated hover:text-fg-muted"
        >
          <ChevronsRight className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-auto px-3 py-3">
        {loading && rows.length === 0 && (
          <div className="text-[12px] text-fg-faint">Loading…</div>
        )}
        {errorMsg && (
          <div className="text-[12px] text-red-400">{errorMsg}</div>
        )}
        {!loading && threads.length === 0 && !errorMsg && (
          <div className="text-[13px] text-fg-faint">
            No comments yet. Start the first thread below.
          </div>
        )}
        {threads.map((t) => {
          const head = t.comments[0]!;
          const rest = t.comments.slice(1);
          return (
            <div
              key={t.thread_id}
              className="mb-3 rounded-md border border-border-soft bg-bg-elevated p-2.5"
            >
              {t.scope === "passage" && t.anchor?.selection.quoted_text && (
                <blockquote className="mb-2 border-l-2 border-border-soft pl-2 text-[12px] italic text-fg-faint">
                  {t.anchor.selection.quoted_text}
                </blockquote>
              )}
              <CommentRow comment={head} currentUserId={currentUserId} />
              {rest.map((r) => (
                <div key={r.id} className="mt-2 border-t border-border-soft pt-2">
                  <CommentRow comment={r} currentUserId={currentUserId} />
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-border-soft px-3 pb-3 pt-3">
        <ComposerShell
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          busy={posting}
          canSend={!!draft.trim() && !posting}
          placeholder="Comment on this share…"
          showAttachButton={false}
          hint={null}
        />
      </div>
    </aside>
  );
}

function CommentRow({
  comment,
  currentUserId,
}: {
  comment: {
    author_user_id: string | null;
    author_session_id: string | null;
    body: string;
    created_at: string;
  };
  currentUserId: string | null;
}) {
  const author = formatAuthor(comment, currentUserId);
  return (
    <div className="text-[13px]">
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-fg-muted">
          {author}
        </span>
        <span className="text-[11px] text-fg-faint">
          {formatRelativeTime(comment.created_at)}
        </span>
      </div>
      <ClippableBody body={comment.body} />
    </div>
  );
}

/**
 * Long comments (multi-paragraph rants, agent-generated essays) crush
 * the sidebar's scannability when they render at full height. Clip to
 * a max height; expose a "Show more" toggle. State is local per row
 * because expansion is a transient UI concern, not server state.
 *
 * The max-height is in CSS units (a content-relative line-clamp
 * doesn't work with `whitespace-pre-wrap` once line wrapping is
 * involved). A ResizeObserver-based "is this overflowing?" check
 * keeps the toggle from appearing on bodies that fit anyway.
 */
const CLIP_MAX_PX = 200;

function ClippableBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflows(el.scrollHeight > CLIP_MAX_PX + 4);
  }, [body]);

  return (
    <div>
      <div
        ref={ref}
        className="leading-snug text-fg whitespace-pre-wrap overflow-hidden"
        style={{
          maxHeight: expanded ? "none" : `${CLIP_MAX_PX}px`,
        }}
      >
        {body}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-accent hover:opacity-80"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * Author display rules — no raw user-id slices in the UI (they aren't
 * meaningful to a human reader). Hierarchy:
 *   • own comments         → "you"
 *   • agent-emitted        → "agent"
 *   • another human, no
 *     resolvable identity   → "someone"
 * X1A-72 (a follow-up) should fetch real display names from /api/users
 * and replace the "someone" fallback. Keeping the unknown bucket
 * explicit avoids leaking the raw uuid.
 */
function formatAuthor(
  comment: {
    author_user_id: string | null;
    author_session_id: string | null;
  },
  currentUserId: string | null,
): string {
  if (comment.author_user_id && comment.author_user_id === currentUserId)
    return "you";
  if (comment.author_session_id) return "agent";
  if (comment.author_user_id) return "someone";
  return "unknown";
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
