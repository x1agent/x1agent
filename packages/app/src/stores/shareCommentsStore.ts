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

  load: (key: ShareKey) => Promise<void>;
  add: (
    key: ShareKey,
    input: {
      thread_id?: string;
      scope: "passage" | "share";
      anchor?: ShareCommentDTO["anchor"];
      body: string;
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

export const useShareCommentsStore = create<ShareCommentsState>((set, get) => ({
  byShareId: {},
  loading: {},
  errors: {},
  shareTypeById: {},

  async load(key) {
    set((s) => ({
      loading: { ...s.loading, [key.shareId]: true },
      errors: { ...s.errors, [key.shareId]: null },
    }));
    try {
      const res = await apiFetch<ShareCommentListResponse>(commentUrl(key));
      set((s) => ({
        byShareId: { ...s.byShareId, [key.shareId]: res.comments },
        shareTypeById: { ...s.shareTypeById, [key.shareId]: res.share_type },
        loading: { ...s.loading, [key.shareId]: false },
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
      // Dedup by (thread_id, seq) — NATS redelivery + optimistic-append
      // can both reach this code path.
      if (
        existing.some(
          (c) =>
            c.thread_id === payload.thread_id && c.seq === payload.seq,
        )
      ) {
        return s;
      }
      return {
        byShareId: {
          ...s.byShareId,
          [payload.share_id]: [...existing, payload].sort((a, b) =>
            a.thread_id === b.thread_id
              ? a.seq - b.seq
              : a.thread_id.localeCompare(b.thread_id),
          ),
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
    comments.sort((a, b) => a.seq - b.seq);
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
