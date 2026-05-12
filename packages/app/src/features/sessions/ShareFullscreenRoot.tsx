import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, History, ListTree, MessageSquare } from "lucide-react";
import type { ShareCommentDTO } from "@x1agent/shared";
import {
  useShareCommentsStore,
  groupThreads,
} from "../../stores/shareCommentsStore";

// Stable module-level empty array — see CLAUDE.md "Frontend state management"
// selector foot-gun rule. Without this, useSyncExternalStore detects a
// "new" array on every render and triggers React error #185.
const EMPTY_ROWS: never[] = [];

interface Props {
  workspaceSlug: string;
  sessionId: string;
  shareId: string;
}

/**
 * Document-commenting fullscreen view (X1A-54).
 *
 * Layout (matches `doc-commenting-mockup-v3.html` § Views 2/3):
 *
 *   ┌────────── 80px rail ──────────┬──── flex doc ────┬── 380px flyout ──┐
 *   │  💬 active                    │                  │  Comments        │
 *   │  ≡ outline                    │  share renderer  │  (threads)       │
 *   │  ⟲ history                    │                  │                  │
 *   └────────────────────────────────┴──────────────────┴──────────────────┘
 *
 * v1 ships the flyout + rail. The mockup's anchor-aligned thread cards
 * + connector lines + in-doc selection-to-comment are tracked as a
 * follow-on commit on this PR (see PR description "Phase-2 polish"
 * list) so the IDOR-bearing backend + the core surface land first.
 *
 * Rail icons use `size-5` per the X1A-54 CEO directive ("blow up the
 * icons matching the AppSidebar pattern"). The pin is `rounded-md`
 * with accent-soft background when active.
 */
export function ShareFullscreenRoot({
  workspaceSlug,
  sessionId,
  shareId,
}: Props) {
  const rows = useShareCommentsStore(
    (s) => s.byShareId[shareId] ?? EMPTY_ROWS,
  );
  const shareType = useShareCommentsStore(
    (s) => s.shareTypeById[shareId] ?? null,
  );
  const load = useShareCommentsStore((s) => s.load);
  const add = useShareCommentsStore((s) => s.add);
  const resolve = useShareCommentsStore((s) => s.resolveThread);
  const unresolve = useShareCommentsStore((s) => s.unresolveThread);

  useEffect(() => {
    load({ workspaceSlug, sessionId, shareId });
  }, [load, workspaceSlug, sessionId, shareId]);

  const threads = useMemo(() => groupThreads(rows), [rows]);
  const unresolved = threads.filter((t) => !t.resolved_at);
  const resolved = threads.filter((t) => t.resolved_at);
  const [showResolved, setShowResolved] = useState(false);
  const visible = showResolved ? threads : unresolved;

  return (
    <div className="grid h-screen grid-cols-[80px_minmax(0,1fr)_380px] bg-bg text-fg">
      {/* ── Rail ──────────────────────────────────────────────── */}
      <aside className="flex flex-col items-center gap-2 border-r border-border-soft bg-rail py-4">
        <a
          href={`/workspaces/${workspaceSlug}/sessions/${sessionId}`}
          aria-label="Back to session"
          className="grid size-9 place-items-center rounded-md text-fg-muted hover:bg-bg-elevated"
        >
          <ArrowLeft className="size-5" />
        </a>
        <div className="grid size-9 place-items-center rounded-md bg-accent-soft text-accent">
          <MessageSquare className="size-5" />
        </div>
        <button
          type="button"
          disabled
          className="grid size-9 cursor-not-allowed place-items-center rounded-md text-fg-faint opacity-60"
          title="Outline (coming soon)"
        >
          <ListTree className="size-5" />
        </button>
        <button
          type="button"
          disabled
          className="grid size-9 cursor-not-allowed place-items-center rounded-md text-fg-faint opacity-60"
          title="History (coming soon)"
        >
          <History className="size-5" />
        </button>
      </aside>

      {/* ── Document body ─────────────────────────────────────── */}
      <main className="overflow-auto px-12 py-8">
        <DocumentFrame
          workspaceSlug={workspaceSlug}
          sessionId={sessionId}
          shareId={shareId}
          shareType={shareType}
        />
      </main>

      {/* ── Right flyout ──────────────────────────────────────── */}
      <aside className="flex flex-col border-l border-border-soft bg-surface-elevated px-4 pb-6 pt-4">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              Comments
            </div>
            {shareType === "site" && (
              <div className="mt-0.5 text-[11px] text-fg-faint">
                On this share
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="text-[11px] text-fg-faint hover:text-fg-muted"
          >
            {showResolved
              ? `Hide resolved (${resolved.length})`
              : `Show resolved (${resolved.length})`}
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-3 overflow-auto">
          {visible.map((thread) => (
            <ThreadCard
              key={thread.thread_id}
              thread={thread}
              onResolve={() =>
                resolve({ workspaceSlug, sessionId, shareId }, thread.thread_id)
              }
              onUnresolve={() =>
                unresolve(
                  { workspaceSlug, sessionId, shareId },
                  thread.thread_id,
                )
              }
            />
          ))}
          {visible.length === 0 && (
            <div className="rounded-md border border-dashed border-border-soft p-4 text-center text-[12px] text-fg-faint">
              No comments yet.
            </div>
          )}
        </div>
        <NewThreadComposer
          onSubmit={async (body) => {
            await add(
              { workspaceSlug, sessionId, shareId },
              { scope: "share", anchor: null, body },
            );
          }}
        />
      </aside>
    </div>
  );
}

function DocumentFrame({
  workspaceSlug,
  sessionId,
  shareId,
  shareType,
}: {
  workspaceSlug: string;
  sessionId: string;
  shareId: string;
  shareType: string | null;
}) {
  // v1: load the share file's bytes via the existing share-file route
  // and render the right way for its type. Markdown gets <article>;
  // HTML gets an iframe (X1A-19 shape). Anchor-aligned scroll tracking
  // is phase-2 polish (see PR description).
  const base = `/api/workspaces/${workspaceSlug}/sessions/${sessionId}/shares/${shareId}/`;
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    if (shareType !== "document") return;
    fetch(base, { credentials: "include" })
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent(""));
  }, [base, shareType]);

  if (shareType === "site") {
    return (
      <iframe
        src={base}
        className="h-[calc(100vh-64px)] w-full max-w-[1100px] rounded-md border border-border-soft bg-white"
        sandbox="allow-scripts allow-same-origin"
        title="Share"
      />
    );
  }
  if (shareType === "document") {
    return (
      <article className="mx-auto max-w-[720px] text-[15px] leading-7 text-fg">
        {content === null ? (
          <div className="text-fg-faint">Loading…</div>
        ) : (
          <pre className="whitespace-pre-wrap font-sans">{content}</pre>
        )}
      </article>
    );
  }
  return (
    <div className="text-fg-faint">
      This share type isn't yet commentable in v1.
    </div>
  );
}

function ThreadCard({
  thread,
  onResolve,
  onUnresolve,
}: {
  thread: ReturnType<typeof groupThreads>[number];
  onResolve: () => Promise<void>;
  onUnresolve: () => Promise<void>;
}) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface">
      <div className="flex flex-col gap-1 p-4 pb-0">
        {thread.scope === "passage" && thread.anchor?.selection.quoted_text ? (
          <div className="border-b border-dotted border-border-soft pb-2 text-[13px] italic leading-relaxed text-fg-faint">
            "{thread.anchor.selection.quoted_text}"
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 p-4 pt-2">
        {thread.comments.map((c) => (
          <CommentRow key={c.id} comment={c} />
        ))}
        <div className="mt-2 flex items-center gap-2">
          {thread.resolved_at ? (
            <button
              type="button"
              onClick={() => void onUnresolve()}
              className="h-8 rounded-md px-3 text-[12px] font-medium text-fg-muted hover:bg-surface-muted"
            >
              Re-open
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onResolve()}
              className="h-8 rounded-md px-3 text-[12px] font-medium text-fg-muted hover:bg-surface-muted"
            >
              Resolve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CommentRow({ comment }: { comment: ShareCommentDTO }) {
  const author = comment.author_user_id
    ? comment.author_user_id.slice(0, 6)
    : comment.author_session_id
      ? "agent"
      : "unknown";
  return (
    <div className="flex items-start gap-2">
      <div className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-muted text-[10px] font-medium text-fg-muted">
        {author.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg-muted">
            {author}
          </span>
          <span className="text-[11px] text-fg-faint">
            {new Date(comment.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <div className="text-[13px] leading-snug text-fg">{comment.body}</div>
      </div>
    </div>
  );
}

function NewThreadComposer({
  onSubmit,
}: {
  onSubmit: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setBody("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="composer-border mt-4 rounded-[14px] p-[2px]"
      data-testid="new-thread-composer"
    >
      <div className="rounded-[12px] bg-surface p-3.5">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          rows={2}
          className="block w-full resize-none bg-transparent text-[15px] leading-snug text-fg placeholder:text-fg-faint focus:outline-none"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setBody("")}
            className="h-8 rounded-md px-3 text-[12px] font-medium text-fg-muted hover:bg-surface-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!body.trim() || busy}
            className="h-8 rounded-md bg-accent px-3 text-[12px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
