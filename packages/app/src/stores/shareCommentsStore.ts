import { create } from "zustand";
import type {
  ShareCommentDTO,
  ShareCommentListResponse,
  ShareCommentThread,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

/**
 * Document-commenting v1 store (X1A-52/53/54).
 *
 * Comments live on a share, not on a session. Re-sharing the same
 * artifact in a new session opens a fresh comment surface — that's a
 * v2 problem. v1 keys threads by share_id alone; the session_id +
 * workspace_slug are carried alongside so the store can fetch /
 * mutate via the API.
 *
 * Reactive update: when a `agent.share_comment_added` NATS event
 * arrives in the SessionStream subscription, the consumer calls
 * `applyServerEvent` with the payload. The store appends the row to
 * the right thread and bumps the count without a refetch.
 */
interface ShareKey {
  workspaceSlug: string;
  sessionId: string;
  shareId: string;
}

interface ShareCommentsState {
  byShareId: Record<string, ShareCommentDTO[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  /** Cache the share-type so the UI can branch on markdown vs HTML
   *  without re-reading the underlying agent.share event. */
  shareTypeById: Record<string, string>;
  /** X1A-72.4 — true while we've loaded a capped window and the server
   * almost certainly has older threads. False once a load returns
   * fewer threads than the requested page size. */
  hasOlderByShareId: Record<string, boolean>;
  /** Mutex on the loadOlder fetch to keep scroll-to-top from fanning
   *  out. */
  loadingOlderByShareId: Record<string, boolean>;

  load: (key: ShareKey) => Promise<void>;
  /** Fetch the page of threads strictly older than the oldest thread
   *  currently in the store. No-op when has-older is false or another
   *  loadOlder is in flight. */
  loadOlder: (key: ShareKey) => Promise<void>;
  add: (
    key: ShareKey,
    input: {
      thread_id?: string;
      scope: "passage" | "share";
      anchor?: ShareCommentDTO["anchor"];
      body: string;
      /**
       * X1A-110 — set when the user clicks "Reply" on a comment. The
       * server rejects with `nested_reply_not_supported` if the named
       * parent is itself a reply, and with `parent_comment_not_in_thread`
       * if it lives in a different thread.
       */
      parent_comment_id?: string;
    },
  ) => Promise<ShareCommentDTO>;
  resolveThread: (key: ShareKey, threadId: string) => Promise<void>;
  unresolveThread: (key: ShareKey, threadId: string) => Promise<void>;

  /** Apply a server-sent event payload (X1A-55 wake plumbing relays
   *  these). Idempotent on (share_id, thread_id, seq). */
  applyServerEvent: (payload: ShareCommentDTO) => void;
}

function commentUrl(k: ShareKey, suffix = ""): string {
  return `/api/workspaces/${k.workspaceSlug}/sessions/${k.sessionId}/shares/${k.shareId}/comments${suffix}`;
}

// X1A-72.4 — initial thread page size. 50 threads covers most active
// review surfaces; scroll-up loads the preceding window.
const INITIAL_THREAD_LIMIT = 50;

/**
 * Earliest thread-head `created_at` across the loaded window. Used as
 * the cursor for the next page fetch — the server returns threads
 * whose head `created_at` is strictly less than this value.
 *
 * Why thread heads (parent_comment_id = null) and not all comments:
 * the server orders threads by `min(created_at)` per thread, which is
 * the head's created_at. Using a reply's created_at as the cursor
 * would either skip threads (when reply.created_at > head.created_at)
 * or fail to advance (when seq-style anomalies push a reply earlier).
 * Heads-only is the only cursor that round-trips cleanly.
 */
function earliestHeadCreatedAt(
  rows: readonly ShareCommentDTO[],
): string | null {
  let min: string | null = null;
  for (const r of rows) {
    if (r.parent_comment_id !== null) continue;
    if (min === null || r.created_at < min) min = r.created_at;
  }
  return min;
}

/** Count of distinct thread_ids in the window. Used to decide
 *  hasOlder: if a fetch returned exactly INITIAL_THREAD_LIMIT
 *  threads we likely capped, so more probably exists. */
function distinctThreadCount(rows: readonly ShareCommentDTO[]): number {
  const seen = new Set<string>();
  for (const r of rows) seen.add(r.thread_id);
  return seen.size;
}

export const useShareCommentsStore = create<ShareCommentsState>((set, get) => ({
  byShareId: {},
  loading: {},
  errors: {},
  shareTypeById: {},
  hasOlderByShareId: {},
  loadingOlderByShareId: {},

  async load(key) {
    set((s) => ({
      loading: { ...s.loading, [key.shareId]: true },
      errors: { ...s.errors, [key.shareId]: null },
    }));
    try {
      const url =
        commentUrl(key) + `?thread_limit=${INITIAL_THREAD_LIMIT}`;
      const res = await apiFetch<ShareCommentListResponse>(url);
      set((s) => ({
        byShareId: { ...s.byShareId, [key.shareId]: res.comments },
        shareTypeById: { ...s.shareTypeById, [key.shareId]: res.share_type },
        loading: { ...s.loading, [key.shareId]: false },
        hasOlderByShareId: {
          ...s.hasOlderByShareId,
          [key.shareId]:
            distinctThreadCount(res.comments) >= INITIAL_THREAD_LIMIT,
        },
      }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, [key.shareId]: false },
        errors: {
          ...s.errors,
          [key.shareId]: (err as Error).message ?? "load_failed",
        },
      }));
    }
  },

  async loadOlder(key) {
    const s = get();
    if (!s.hasOlderByShareId[key.shareId]) return;
    if (s.loadingOlderByShareId[key.shareId]) return;
    const existing = s.byShareId[key.shareId] ?? [];
    const cursor = earliestHeadCreatedAt(existing);
    if (cursor === null) return;
    set((prev) => ({
      loadingOlderByShareId: {
        ...prev.loadingOlderByShareId,
        [key.shareId]: true,
      },
    }));
    try {
      const url =
        commentUrl(key) +
        `?thread_limit=${INITIAL_THREAD_LIMIT}` +
        `&before_thread_first_created_at=${encodeURIComponent(cursor)}`;
      const res = await apiFetch<ShareCommentListResponse>(url);
      set((prev) => {
        const cur = prev.byShareId[key.shareId] ?? [];
        const seenIds = new Set(cur.map((c) => c.id));
        const fresh = res.comments.filter((c) => !seenIds.has(c.id));
        const next = [...fresh, ...cur];
        return {
          byShareId: { ...prev.byShareId, [key.shareId]: next },
          hasOlderByShareId: {
            ...prev.hasOlderByShareId,
            [key.shareId]:
              distinctThreadCount(res.comments) >= INITIAL_THREAD_LIMIT,
          },
          loadingOlderByShareId: {
            ...prev.loadingOlderByShareId,
            [key.shareId]: false,
          },
        };
      });
    } catch (err) {
      set((prev) => ({
        loadingOlderByShareId: {
          ...prev.loadingOlderByShareId,
          [key.shareId]: false,
        },
        errors: {
          ...prev.errors,
          [key.shareId]: (err as Error).message ?? "load_more_failed",
        },
      }));
    }
  },

  async add(key, input) {
    const res = await apiFetch<{ comment: ShareCommentDTO; thread_id: string }>(
      commentUrl(key),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    // Optimistic append. The server is source-of-truth so we use the
    // returned row's seq + ids, not a generated stub.
    get().applyServerEvent(res.comment);
    return res.comment;
  },

  async resolveThread(key, threadId) {
    await apiFetch(commentUrl(key, `/${threadId}/resolve`), {
      method: "PATCH",
    });
    set((s) => {
      const rows = (s.byShareId[key.shareId] ?? []).map((c) =>
        c.thread_id === threadId
          ? { ...c, resolved_at: new Date().toISOString() }
          : c,
      );
      return {
        byShareId: { ...s.byShareId, [key.shareId]: rows },
      };
    });
  },

  async unresolveThread(key, threadId) {
    await apiFetch(commentUrl(key, `/${threadId}/resolve`), {
      method: "DELETE",
    });
    set((s) => {
      const rows = (s.byShareId[key.shareId] ?? []).map((c) =>
        c.thread_id === threadId ? { ...c, resolved_at: null } : c,
      );
      return {
        byShareId: { ...s.byShareId, [key.shareId]: rows },
      };
    });
  },

  applyServerEvent(payload) {
    set((s) => {
      const existing = s.byShareId[payload.share_id] ?? [];
      // Dedup by id (UUID, globally unique). NATS redelivery,
      // optimistic-append after POST, and a fresh REST refresh can
      // all reach this path; id is the only key present and unique
      // across all three. The previous (thread_id, seq) dedup broke
      // for NATS-only deliveries because the
      // agent.share_comment_added NATS payload doesn't carry seq.
      if (existing.some((c) => c.id === payload.id)) {
        return s;
      }
      // Within a thread: parents (parent_comment_id=null) render first,
      // replies by created_at. Sorting by seq alone breaks for NATS
      // arrivals because SessionRoot's bridge synth path doesn't carry
      // seq from the wire — it hard-codes seq=0, which sorts a fresh
      // reply ABOVE the head (head.seq>=1 from REST). The result was
      // the new bot reply rendering as if it were the thread head
      // until a manual refresh brought real seq values in. Created_at
      // is always present from the server.
      // Across threads: thread head's created_at, ascending.
      return {
        byShareId: {
          ...s.byShareId,
          [payload.share_id]: [...existing, payload].sort((a, b) => {
            if (a.thread_id === b.thread_id) {
              const ap = a.parent_comment_id === null ? 0 : 1;
              const bp = b.parent_comment_id === null ? 0 : 1;
              if (ap !== bp) return ap - bp;
              return a.created_at.localeCompare(b.created_at);
            }
            return a.created_at.localeCompare(b.created_at);
          }),
        },
      };
    });
  },
}));

/**
 * Group rows into threads for rendering. Resolved-at is coalesced
 * across the thread's rows because the server fans the value to every
 * row of the thread on resolve.
 */
export function groupThreads(rows: ShareCommentDTO[]): ShareCommentThread[] {
  const byThread = new Map<string, ShareCommentDTO[]>();
  for (const r of rows) {
    const arr = byThread.get(r.thread_id) ?? [];
    arr.push(r);
    byThread.set(r.thread_id, arr);
  }
  const threads: ShareCommentThread[] = [];
  for (const [thread_id, comments] of byThread) {
    // Parents (parent_comment_id=null) first, then replies by created_at.
    // Robust against NATS payloads that don't carry seq (head from REST
    // has seq>=1, NATS-synth reply has seq=0 → seq-sort puts reply above
    // head → reply renders as thread head). created_at + parent gate
    // gives deterministic order regardless of seq presence.
    comments.sort((a, b) => {
      const ap = a.parent_comment_id === null ? 0 : 1;
      const bp = b.parent_comment_id === null ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.created_at.localeCompare(b.created_at);
    });
    const head = comments[0]!;
    threads.push({
      thread_id,
      scope: head.scope,
      anchor: head.anchor,
      comments,
      resolved_at: head.resolved_at,
    });
  }
  // Chronological order — oldest thread first, newest at the bottom,
  // matching chat-timeline reading. Replies within a thread are
  // already seq-ascending above, so the whole sidebar reads top-to-
  // bottom in submission order.
  return threads.sort((a, b) => {
    const at = a.comments[0]!.created_at;
    const bt = b.comments[0]!.created_at;
    return at.localeCompare(bt);
  });
}

/** Count unresolved threads. Used by the SharePill comment-chip. */
export function unresolvedThreadCount(rows: ShareCommentDTO[]): number {
  return groupThreads(rows).filter((t) => !t.resolved_at).length;
}
