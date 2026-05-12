import { connect, StringCodec, type NatsConnection } from "nats";
import type {
  SessionRepository,
  ShareCommentRepository,
} from "@x1agent/domain-sessions";
import { SessionId, ShareThreadId } from "@x1agent/domain-sessions";
import { natsConnectOpts } from "../composition/nats-provider-gateway.js";
import {
  publishCommentAddedWake,
  publishCommentResolvedWake,
} from "../orchestration/wake-publisher.js";

/**
 * X1A-55 — comment-wake subscriber.
 *
 * Subscribes to the two share-comment events published by the
 * post-share-comment / resolve-share-thread application paths
 * (`agent.share_comment_added` + `agent.share_comment_thread_resolved`)
 * and turns each into a `user.message` wake injected into the share's
 * producing session.
 *
 * Routing (v1, per X1A-55 ticket):
 *   - Only the share's `producing_session_id` gets the wake.
 *   - Skip wake when `author_session_id === producing_session_id`
 *     (anti-loop — agent commenting on its own share).
 *   - Skip wake when the producing session is terminal (complete or
 *     failed) — no point waking a dead pod, and the existing
 *     state-change watcher already handles the live → terminal edge.
 *
 * Out of scope for v1: multi-session fan-out, per-agent `@mention`
 * routing, opt-out preferences. Tracked in the X1A-55 ticket body.
 *
 * Runs alongside the other subscribers (session events, audit)
 * inside the api process. Reconnect is handled by the NATS client.
 */
export interface StartCommentWakeSubscriberOptions {
  natsUrl: string;
  sessions: SessionRepository;
  /**
   * Re-verifies routing fields against the DB before publishing a wake.
   * Without this, the subscriber would trust the NATS payload's
   * `producing_session_id` — which an authenticated bus client could
   * spoof to deliver attacker-chosen `comment_body` text into another
   * workspace's running session. Looking up the thread by `thread_id`
   * yields the authoritative session and share that own this comment.
   */
  comments: ShareCommentRepository;
}

export interface CommentWakeSubscriberHandle {
  close: () => Promise<void>;
}

const SUBJECT_COMMENT_ADDED = "agent.share_comment_added";
const SUBJECT_THREAD_RESOLVED = "agent.share_comment_thread_resolved";

interface CommentAddedPayload {
  share_id?: string;
  thread_id?: string;
  comment_id?: string;
  actor_user_id?: string | null;
  actor_session_id?: string | null;
  workspace_id?: string;
  session_id?: string;
  share_type?: string;
  comment_scope?: "passage" | "share";
  anchor?: {
    selection?: { quoted_text?: string };
  } | null;
  comment_body?: string;
  producing_session_id?: string;
  producing_agent_id?: string;
}

interface ThreadResolvedPayload {
  share_id?: string;
  thread_id?: string;
  resolved_by_user_id?: string | null;
  resolved?: boolean;
  workspace_id?: string;
  session_id?: string;
  share_type?: string;
  producing_session_id?: string;
  producing_agent_id?: string;
  /**
   * Server-stamped transition timestamp. Used to discriminate the
   * msgId for resolve toggles — without it, JetStream's dedup window
   * would collapse resolve→unresolve→re-resolve on the same thread
   * back to a single message and the orchestrator never hears the
   * later transition.
   */
  transitioned_at?: string;
}

export async function startCommentWakeSubscriber(
  opts: StartCommentWakeSubscriberOptions,
): Promise<CommentWakeSubscriberHandle> {
  const nc = await connect(natsConnectOpts(opts.natsUrl));
  const sc = StringCodec();

  console.log(
    `[comment-wake] subscribed to ${SUBJECT_COMMENT_ADDED} + ${SUBJECT_THREAD_RESOLVED}`,
  );

  // Queue group "comment-wake": when the api scales to multiple
  // replicas, NATS delivers each message to exactly one subscriber in
  // the group. Without this, every replica would publish its own wake
  // for every comment.
  const addedSub = nc.subscribe(SUBJECT_COMMENT_ADDED, {
    queue: "comment-wake",
  });
  void (async () => {
    for await (const m of addedSub) {
      try {
        const payload = JSON.parse(sc.decode(m.data)) as CommentAddedPayload;
        await handleCommentAdded(nc, opts.sessions, opts.comments, payload);
      } catch (err) {
        console.warn(
          `[comment-wake] added handler failed: ${(err as Error).message}`,
        );
      }
    }
  })();

  const resolvedSub = nc.subscribe(SUBJECT_THREAD_RESOLVED, {
    queue: "comment-wake",
  });
  void (async () => {
    for await (const m of resolvedSub) {
      try {
        const payload = JSON.parse(sc.decode(m.data)) as ThreadResolvedPayload;
        await handleThreadResolved(nc, opts.sessions, opts.comments, payload);
      } catch (err) {
        console.warn(
          `[comment-wake] resolved handler failed: ${(err as Error).message}`,
        );
      }
    }
  })();

  return {
    close: async () => {
      try {
        await addedSub.drain();
      } catch {
        // best-effort
      }
      try {
        await resolvedSub.drain();
      } catch {
        // best-effort
      }
      try {
        await nc.close();
      } catch {
        // best-effort
      }
    },
  };
}

async function handleCommentAdded(
  nc: NatsConnection,
  sessions: SessionRepository,
  comments: ShareCommentRepository,
  p: CommentAddedPayload,
): Promise<void> {
  if (!p.share_id || !p.thread_id || !p.comment_id) return;

  // Re-verify against the DB before publishing the wake. The NATS
  // payload's `producing_session_id` + `share_id` are routing inputs
  // we MUST NOT trust — an authenticated bus client could otherwise
  // forge a payload that delivers attacker-chosen `comment_body` text
  // into any session id it names. `findThread` returns the comment's
  // authoritative share + session as committed by `postShareComment`.
  const thread = await comments.findThread(
    ShareThreadId(p.thread_id),
  );
  if (!thread) return;
  if (thread.shareId !== p.share_id) return;

  const producingSessionId = thread.sessionId;

  // Anti-loop: don't wake the agent on its own reply.
  if (
    p.actor_session_id &&
    p.actor_session_id === producingSessionId
  ) {
    return;
  }
  if (await isTerminal(sessions, producingSessionId)) return;

  await publishCommentAddedWake(nc, producingSessionId, {
    shareId: thread.shareId,
    threadId: p.thread_id,
    commentId: p.comment_id,
    authorDisplay: formatAuthor(p.actor_user_id, p.actor_session_id),
    scope: p.comment_scope === "passage" ? "passage" : "share",
    anchorQuote: p.anchor?.selection?.quoted_text ?? null,
    body: p.comment_body ?? "",
  });
}

async function handleThreadResolved(
  nc: NatsConnection,
  sessions: SessionRepository,
  comments: ShareCommentRepository,
  p: ThreadResolvedPayload,
): Promise<void> {
  if (!p.share_id || !p.thread_id) return;

  // Same DB re-verification as handleCommentAdded — derive the routed
  // session from the thread row, not from the NATS payload.
  const thread = await comments.findThread(
    ShareThreadId(p.thread_id),
  );
  if (!thread) return;
  if (thread.shareId !== p.share_id) return;

  const producingSessionId = thread.sessionId;
  if (await isTerminal(sessions, producingSessionId)) return;
  // Resolve isn't author-attributed at the session-id level (the
  // resolver is a human via REST, not another agent session in v1),
  // so no anti-loop is required.
  await publishCommentResolvedWake(nc, producingSessionId, {
    shareId: thread.shareId,
    threadId: p.thread_id,
    resolverDisplay: p.resolved_by_user_id
      ? "human"
      : "platform",
    resolved: !!p.resolved,
    transitionedAt: p.transitioned_at,
  });
}

async function isTerminal(
  sessions: SessionRepository,
  sessionId: string,
): Promise<boolean> {
  const s = await sessions.findById(SessionId(sessionId));
  if (!s) return true;
  return s.status === "complete" || s.status === "failed";
}

function formatAuthor(
  userId: string | null | undefined,
  sessionId: string | null | undefined,
): string {
  if (userId) return `human ${userId.slice(0, 8)}`;
  if (sessionId) return `agent: ${sessionId.slice(0, 8)}`;
  return "unknown";
}
