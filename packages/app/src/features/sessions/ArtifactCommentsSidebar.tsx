import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, MessageSquare } from "lucide-react";
import type { ShareCommentDTO } from "@x1agent/shared";
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

/**
 * X1A-105 truncation thresholds. Apply whichever trips first.
 * The 5-line / 240-char heuristic matches the inline ThreadSnippets
 * preview length so the two surfaces clip at the same point.
 */
export const COMMENT_CLIP_CHARS = 240;
export const COMMENT_CLIP_LINES = 5;

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
 * Threading visual rhythm (X1A-105):
 *   • Agent comments render full-width within the thread card.
 *   • User comments render inset / right-aligned in a softly-tinted
 *     bubble, matching the EventCard user-turn convention so the
 *     comment thread visually rhymes with the chat timeline.
 *
 * Auto-scroll (X1A-105): when a new comment arrives via WS / optimistic
 * append, the thread list scrolls to the bottom ONLY if the viewer was
 * already pinned to the bottom. Anyone reading further up keeps their
 * place.
 *
 * All state lives in `useShareCommentsStore`; this component is a
 * presentation + form-handler shell with no useState beyond the
 * composer's draft text and the just-posted-by-me id set (used to
 * render fresh own-posts expanded by default).
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
  // Tracks comment ids freshly posted by the current user in this
  // session — so the just-posted body renders expanded even if it
  // would normally trip the See-more clamp.
  const [justPostedIds, setJustPostedIds] = useState<Set<string>>(
    () => new Set(),
  );

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
      const posted = await add(key, { scope: "share", body });
      setJustPostedIds((prev) => {
        const next = new Set(prev);
        next.add(posted.id);
        return next;
      });
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

      <ThreadList
        rows={rows}
        threads={threads}
        loading={loading}
        errorMsg={errorMsg}
        currentUserId={currentUserId}
        justPostedIds={justPostedIds}
      />

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

/**
 * Scrolling thread list. Splits out the scroll-pinning logic so the
 * top-level component stays a presentation shell. The list watches
 * how many comment rows there are (across all threads, the "tail
 * count") and conditionally scrolls to the bottom only if the user
 * was already at the bottom before the new row arrived — same rule
 * as a chat client.
 */
function ThreadList({
  rows,
  threads,
  loading,
  errorMsg,
  currentUserId,
  justPostedIds,
}: {
  rows: ShareCommentDTO[];
  threads: ReturnType<typeof groupThreads>;
  loading: boolean;
  errorMsg: string | null;
  currentUserId: string | null;
  justPostedIds: Set<string>;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Distance-from-bottom threshold (px). Anything within this counts
  // as "at the bottom" — accounts for sub-pixel rounding and a small
  // affordance so the user doesn't have to be pixel-perfect.
  const AT_BOTTOM_PX = 32;
  const wasAtBottomRef = useRef(true);
  const lastCountRef = useRef(rows.length);

  // Track whether the user is currently pinned to the bottom. Updated
  // on scroll; consumed in the layout effect below to decide whether
  // a count bump should auto-scroll.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      wasAtBottomRef.current = dist <= AT_BOTTOM_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Initial state — first paint with rows already present.
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // When the row count grows, if the user was at the bottom before,
  // smooth-scroll the new row into view. Shrinking (resolve/un-resolve
  // doesn't shrink, but redundancy doesn't hurt) is a no-op.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const prev = lastCountRef.current;
    lastCountRef.current = rows.length;
    if (rows.length > prev && wasAtBottomRef.current) {
      // requestAnimationFrame so the DOM is committed before we measure.
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }, [rows.length]);

  return (
    <div
      ref={scrollerRef}
      className="flex-1 overflow-auto px-3 py-3"
      data-testid="comment-thread-list"
    >
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
      {threads.map((t) => (
        <div
          key={t.thread_id}
          className="mb-3 rounded-md border border-border-soft bg-bg-elevated p-2.5"
          data-testid="comment-thread"
        >
          {t.scope === "passage" && t.anchor?.selection.quoted_text && (
            <blockquote className="mb-2 border-l-2 border-border-soft pl-2 text-[12px] italic text-fg-faint">
              {t.anchor.selection.quoted_text}
            </blockquote>
          )}
          {t.comments.map((c, i) => (
            <CommentRow
              key={c.id}
              comment={c}
              currentUserId={currentUserId}
              isFirst={i === 0}
              initialExpanded={justPostedIds.has(c.id)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function CommentRow({
  comment,
  currentUserId,
  isFirst,
  initialExpanded,
}: {
  comment: ShareCommentDTO;
  currentUserId: string | null;
  isFirst: boolean;
  initialExpanded: boolean;
}) {
  const author = formatAuthor(comment, currentUserId);
  // X1A-105: agent comments take the full thread width; user comments
  // (own or someone else's) sit in an inset right-aligned bubble so
  // the user vs agent rhythm is unambiguous at a glance.
  const isUser = !comment.author_session_id;
  const wrapperClass = isFirst ? "" : "mt-2";

  if (isUser) {
    return (
      <div
        className={`${wrapperClass} flex justify-end`}
        data-comment-author={comment.author_user_id ?? "unknown"}
        data-author-kind="user"
      >
        <div className="max-w-[85%] rounded-md bg-bg/70 px-2.5 py-1.5 text-[13px]">
          <div className="mb-0.5 flex items-baseline gap-2">
            <span className="text-[12px] font-semibold text-fg-muted">
              {author}
            </span>
            <span className="text-[11px] text-fg-faint">
              {formatRelativeTime(comment.created_at)}
            </span>
          </div>
          <ClippableBody
            body={comment.body}
            initialExpanded={initialExpanded}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${wrapperClass} block w-full text-[13px]`}
      data-comment-author={comment.author_session_id ?? "agent"}
      data-author-kind="agent"
    >
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-fg-muted">
          {author}
        </span>
        <span className="text-[11px] text-fg-faint">
          {formatRelativeTime(comment.created_at)}
        </span>
      </div>
      <ClippableBody body={comment.body} initialExpanded={initialExpanded} />
    </div>
  );
}

/**
 * Long comments (multi-paragraph rants, agent-generated essays) crush
 * the sidebar's scannability when they render at full height. Clip at
 * the X1A-105 threshold (~5 lines / ~240 chars, whichever trips first)
 * and expose a "See more" toggle. State is local per row because
 * expansion is a transient UI concern.
 *
 * `initialExpanded` lets the parent override the default clamp for
 * just-posted-by-current-user comments — the X1A-105 rule "don't
 * immediately hide what they just wrote."
 *
 * Two heuristics are stacked because they catch different shapes:
 *   • char count — long single-paragraph rants.
 *   • rendered scrollHeight vs a 5-line cap (`maxHeight: 5 * 1.5em`)
 *     — multi-paragraph posts whose char count is below 240 but whose
 *     line wrapping still pushes well past 5 lines.
 */
function ClippableBody({
  body,
  initialExpanded,
}: {
  body: string;
  initialExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // If the parent flips us to expanded (e.g. just-posted), honor it
  // even if local state has drifted from a prior render.
  useEffect(() => {
    if (initialExpanded) setExpanded(true);
  }, [initialExpanded]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Treat over-threshold by either measure as overflowing. The char
    // check is cheap and resilient to fonts; the height check catches
    // wrap-driven overflow.
    const overChars = body.length > COMMENT_CLIP_CHARS;
    // Compare against the clamped 5-line cap. `lineHeight: 1.5` ≈
    // leading-snug. We let the browser do the measurement.
    const overLines = el.scrollHeight > el.clientHeight + 2;
    setOverflows(overChars || overLines);
  }, [body]);

  // `--clamp-lines` drives a `webkit-line-clamp` style fallback when
  // the height-based check is inconclusive (zero-width container).
  const collapsedStyle: React.CSSProperties = {
    display: "-webkit-box",
    WebkitLineClamp: COMMENT_CLIP_LINES,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
  };

  return (
    <div>
      <div
        ref={ref}
        className="leading-snug text-fg whitespace-pre-wrap"
        style={expanded ? undefined : collapsedStyle}
      >
        {body}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-accent hover:opacity-80"
          data-testid="see-more-toggle"
        >
          {expanded ? "See less" : "See more"}
        </button>
      )}
    </div>
  );
}

export { ClippableBody };

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
