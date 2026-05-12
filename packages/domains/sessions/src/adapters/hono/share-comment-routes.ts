import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  ShareThreadId,
  ThreadNotFoundError,
  ThreadNotVisibleError,
  ShareNotFoundError,
  isCommentScope,
  type CommentScope,
  type PassageAnchor,
} from "../../domain/share-comment.js";
import { SessionId } from "../../domain/session.js";
import { postShareComment } from "../../application/post-share-comment.js";
import {
  findShareInSession,
  resolveSessionVisibility,
  type ShareVisibilityDeps,
} from "../../application/share-visibility.js";
import {
  resolveShareThread,
  type ResolveShareThreadDeps,
} from "../../application/resolve-share-thread.js";
import type { ShareCommentRepository } from "../../ports/share-comment-repository.js";
import type { ShareCommentPublisher } from "../../ports/share-comment-publisher.js";
import type { SessionEventRepository } from "../../ports/session-event-repository.js";

/**
 * Hono routes for document commenting v1.
 *
 * Mounted under `/api/workspaces/:slug/sessions/:sessionId/shares/:shareId/comments`.
 * The session_id appears in the URL because shares are session-scoped
 * (they're derived from `session_events` of type `agent.share`) — there
 * is no workspace-wide `shares.id` table. Same convention as the
 * existing `WorkspaceShareRoutes` in `packages/api/src/shares/routes.ts`.
 *
 * IDOR check pattern on every route:
 *   1. Resolve the workspace slug → workspace_id.
 *   2. Resolve the session → confirm visibility (workspace member OR
 *      session_user_shares grantee). Cross-tenant hits return 404.
 *   3. Resolve the share_id within the session via `findShareInSession`
 *      (404 if no `agent.share` event with that share_id exists on
 *      this session). This catches "valid session, but the share_id in
 *      the URL belongs to a sibling session in the same workspace"
 *      because we walk THIS session's events specifically.
 *   4. For thread-scoped routes, `resolveShareThread` does a second
 *      IDOR check: thread_id → share_id, must match the URL share_id.
 *
 * "thread_id from a foreign workspace" is rejected at step 4; "thread_id
 * + share_id from different shares in the same session" is also
 * rejected at step 4.
 */
export interface ShareCommentRoutesConfig {
  comments: ShareCommentRepository;
  events: SessionEventRepository;
  publisher: ShareCommentPublisher;
  visibility: ShareVisibilityDeps;
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  /**
   * Maps a session_id to (producing_session_id, producing_agent_id).
   * v1: the producing session IS the supplied session (shares created
   * by an agent always live in that agent's session). Kept as a closure
   * so X1A-55 can swap a richer implementation later without touching
   * this domain.
   */
  resolveProducingContext: (
    sessionId: SessionId,
  ) => Promise<{ producingSessionId: SessionId; producingAgentId: string }>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

function statusFor(err: unknown): number {
  if (err instanceof ThreadNotFoundError) return 404;
  if (err instanceof ShareNotFoundError) return 404;
  if (err instanceof ThreadNotVisibleError) return 403;
  if (err instanceof DomainError) return 400;
  return 500;
}

function errBody(err: unknown): { error: string; message?: string } {
  if (err instanceof DomainError) {
    return { error: err.code, message: err.message };
  }
  return { error: "internal" };
}

function serialiseComment(c: {
  id: string;
  shareId: string;
  threadId: string;
  seq: number;
  sessionId: string;
  shareType: string;
  commentScope: CommentScope;
  anchorJson: PassageAnchor | null;
  body: string;
  authorUserId: string | null;
  authorSessionId: string | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: c.id,
    share_id: c.shareId,
    thread_id: c.threadId,
    seq: c.seq,
    session_id: c.sessionId,
    share_type: c.shareType,
    scope: c.commentScope,
    anchor: c.anchorJson,
    body: c.body,
    author_user_id: c.authorUserId,
    author_session_id: c.authorSessionId,
    resolved_at: c.resolvedAt ? c.resolvedAt.toISOString() : null,
    resolved_by_user_id: c.resolvedByUserId,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

export function createShareCommentRoutes(
  cfg: ShareCommentRoutesConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  /**
   * Resolve `(slug, sessionId, shareId)` to a usable context. Cross-
   * tenant hits collapse to 404 to hide existence; sibling-session
   * mismatches do the same. Returns the visibility result + share_type
   * for the comment write/validation path.
   */
  const loadCtx = async (
    c: Context,
  ): Promise<
    | {
        sessionId: SessionId;
        workspaceId: WorkspaceId;
        shareId: string;
        shareType: string;
      }
    | { error: "workspace_not_found" | "session_not_found" | "share_not_found" }
  > => {
    const actor = cfg.getActor(c);
    if (!actor) return { error: "session_not_found" }; // unauthenticated path handled upstream
    const slug = c.req.param("slug")!;
    const sessionIdRaw = c.req.param("sessionId")!;
    const shareId = c.req.param("shareId")!;
    let wsId: WorkspaceId | null = null;
    try {
      wsId = await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return { error: "workspace_not_found" };
    }
    if (!wsId) return { error: "workspace_not_found" };

    const sessionId = SessionId(sessionIdRaw);
    const vis = await resolveSessionVisibility(
      cfg.visibility,
      sessionId,
      actor.userId,
    );
    if ("error" in vis) {
      return {
        error:
          vis.error === "not_found" ? "session_not_found" : "session_not_found",
      };
    }
    if (vis.ok.workspaceId !== wsId) {
      // Session exists but in a different workspace than the slug
      // claimed — 404, again hiding existence.
      return { error: "session_not_found" };
    }

    const share = await findShareInSession(
      { events: cfg.events },
      sessionId,
      shareId,
    );
    if (!share) return { error: "share_not_found" };
    return {
      sessionId,
      workspaceId: wsId,
      shareId,
      shareType: share.shareType,
    };
  };

  // ── GET /  — list comments on this share ─────────────────────────
  app.get("/", async (c) => {
    const ctx = await loadCtx(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, 404);
    const rows = await cfg.comments.listByShare(ctx.sessionId, ctx.shareId);
    return c.json({
      comments: rows.map(serialiseComment),
      share_id: ctx.shareId,
      share_type: ctx.shareType,
    });
  });

  // ── POST /  — create thread (no thread_id) or reply ──────────────
  app.post("/", async (c) => {
    const actor = cfg.getActor(c)!;
    const ctx = await loadCtx(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      thread_id?: string;
      scope?: string;
      anchor?: PassageAnchor | null;
      body?: string;
    };
    if (!isCommentScope(body.scope ?? "")) {
      return c.json({ error: "invalid_comment_scope" }, 400);
    }

    // If the caller supplied a thread_id, IDOR-check it against the
    // URL share_id (rejects "thread_id from share A, URL says share B").
    let threadId: ShareThreadId | undefined;
    if (body.thread_id) {
      try {
        const t = await resolveShareThread(
          {
            comments: cfg.comments,
            canSeeSession: async () => true, // already verified above
          },
          ShareThreadId(body.thread_id),
          ctx.shareId,
        );
        threadId = ShareThreadId(body.thread_id);
        // Defence: thread's session must equal URL session too.
        if (t.sessionId !== ctx.sessionId) {
          return c.json({ error: "thread_not_visible" }, 403);
        }
      } catch (err) {
        return c.json(errBody(err), statusFor(err) as 400);
      }
    }

    try {
      const result = await postShareComment(
        {
          comments: cfg.comments,
          publisher: cfg.publisher,
          resolveProducingContext: cfg.resolveProducingContext,
        },
        {
          sessionId: ctx.sessionId,
          workspaceId: ctx.workspaceId,
          shareId: ctx.shareId,
          shareType: ctx.shareType,
          threadId,
          scope: body.scope as CommentScope,
          anchor: body.anchor ?? null,
          body: body.body ?? "",
          authorUserId: actor.userId,
          authorSessionId: null,
        },
      );
      return c.json(
        {
          comment: serialiseComment(result.comment),
          thread_id: result.threadId,
        },
        201,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
  });

  // ── PATCH /:threadId/resolve  — mark thread resolved ────────────
  app.patch("/:threadId/resolve", async (c) => {
    const actor = cfg.getActor(c)!;
    const ctx = await loadCtx(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, 404);

    const threadId = ShareThreadId(c.req.param("threadId")!);
    let resolved: Awaited<
      ReturnType<typeof resolveShareThread>
    > | null = null;
    try {
      resolved = await resolveShareThread(
        {
          comments: cfg.comments,
          canSeeSession: async () => true,
        } satisfies ResolveShareThreadDeps,
        threadId,
        ctx.shareId,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
    if (!resolved) return c.json({ error: "thread_not_found" }, 404);

    const now = new Date();
    await cfg.comments.setResolved(threadId, actor.userId, now);
    const producing = await cfg.resolveProducingContext(ctx.sessionId);
    await cfg.publisher.threadResolved({
      shareId: ctx.shareId,
      threadId,
      resolvedByUserId: actor.userId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      shareType: ctx.shareType,
      resolved: true,
      producingSessionId: producing.producingSessionId,
      producingAgentId: producing.producingAgentId,
    });
    return c.json({ thread_id: threadId, resolved_at: now.toISOString() });
  });

  // ── DELETE /:threadId/resolve  — reverse a resolve ──────────────
  app.delete("/:threadId/resolve", async (c) => {
    const ctx = await loadCtx(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, 404);
    const threadId = ShareThreadId(c.req.param("threadId")!);

    try {
      await resolveShareThread(
        {
          comments: cfg.comments,
          canSeeSession: async () => true,
        } satisfies ResolveShareThreadDeps,
        threadId,
        ctx.shareId,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }

    await cfg.comments.setResolved(threadId, null, null);
    const producing = await cfg.resolveProducingContext(ctx.sessionId);
    await cfg.publisher.threadResolved({
      shareId: ctx.shareId,
      threadId,
      resolvedByUserId: null,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      shareType: ctx.shareType,
      resolved: false,
      producingSessionId: producing.producingSessionId,
      producingAgentId: producing.producingAgentId,
    });
    return c.body(null, 204);
  });

  // ── PATCH /:threadId/:seq  — edit own comment body ──────────────
  app.patch("/:threadId/:seq", async (c) => {
    const actor = cfg.getActor(c)!;
    const ctx = await loadCtx(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, 404);
    const threadId = ShareThreadId(c.req.param("threadId")!);
    const seq = Number(c.req.param("seq"));
    if (!Number.isInteger(seq) || seq < 1) {
      return c.json({ error: "invalid_seq" }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as { body?: string };
    if (typeof body.body !== "string" || body.body.trim().length === 0) {
      return c.json({ error: "empty_comment_body" }, 400);
    }

    try {
      await resolveShareThread(
        {
          comments: cfg.comments,
          canSeeSession: async () => true,
        } satisfies ResolveShareThreadDeps,
        threadId,
        ctx.shareId,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }

    const existing = await cfg.comments.findOne(ctx.shareId, threadId, seq);
    if (!existing) return c.json({ error: "comment_not_found" }, 404);
    if (existing.authorUserId !== actor.userId) {
      return c.json({ error: "comment_not_owned" }, 403);
    }
    const updated = await cfg.comments.updateBody(existing.id, body.body);
    if (!updated) return c.json({ error: "comment_not_found" }, 404);
    return c.json({ comment: serialiseComment(updated) });
  });

  // ── DELETE /:threadId/:seq  — delete own comment ────────────────
  app.delete("/:threadId/:seq", async (c) => {
    const actor = cfg.getActor(c)!;
    const ctx = await loadCtx(c);
    if ("error" in ctx) return c.json({ error: ctx.error }, 404);
    const threadId = ShareThreadId(c.req.param("threadId")!);
    const seq = Number(c.req.param("seq"));
    if (!Number.isInteger(seq) || seq < 1) {
      return c.json({ error: "invalid_seq" }, 400);
    }

    try {
      await resolveShareThread(
        {
          comments: cfg.comments,
          canSeeSession: async () => true,
        } satisfies ResolveShareThreadDeps,
        threadId,
        ctx.shareId,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }

    const existing = await cfg.comments.findOne(ctx.shareId, threadId, seq);
    if (!existing) return c.json({ error: "comment_not_found" }, 404);
    if (existing.authorUserId !== actor.userId) {
      return c.json({ error: "comment_not_owned" }, 403);
    }
    await cfg.comments.remove(existing.id);
    return c.body(null, 204);
  });

  return app;
}

/**
 * Internal-token-authenticated routes used by the sidecar to forward
 * `share_comment` MCP-tool calls into the API. Bare thread_id /
 * share_id input from an agent goes through the same IDOR gate as the
 * user-facing routes — see CEO 2026-05-11 hard requirement.
 *
 * Mounted under `/api/internal/share-comments` and gated by the
 * existing internal-token middleware (X-Internal-Token).
 */
export interface InternalShareCommentRoutesConfig {
  comments: ShareCommentRepository;
  events: SessionEventRepository;
  publisher: ShareCommentPublisher;
  visibility: ShareVisibilityDeps;
  resolveProducingContext: (
    sessionId: SessionId,
  ) => Promise<{ producingSessionId: SessionId; producingAgentId: string }>;
}

export function createInternalShareCommentRoutes(
  cfg: InternalShareCommentRoutesConfig,
): Hono {
  const app = new Hono();

  /**
   * POST /  — agent posts a comment.
   *
   * Required body fields:
   *   - author_session_id (the agent session calling this)
   *   - one of:
   *       (a) thread_id → reply to existing thread (IDOR-checked)
   *       (b) session_id + share_id + scope + anchor? → open new thread
   */
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      author_session_id?: string;
      thread_id?: string;
      session_id?: string;
      share_id?: string;
      scope?: string;
      anchor?: PassageAnchor | null;
      body?: string;
    };
    if (!body.author_session_id) {
      return c.json({ error: "missing_author_session_id" }, 400);
    }
    const authorSessionId = SessionId(body.author_session_id);

    // ── Reply path: thread_id resolves to share_id + share_type ────
    if (body.thread_id) {
      const threadId = ShareThreadId(body.thread_id);
      const located = await cfg.comments.findThread(threadId);
      if (!located) return c.json({ error: "thread_not_found" }, 404);

      // The author session must be in the SAME workspace as the share.
      // For an agent author this is the canonical IDOR check —
      // foreign thread_ids leak nothing because the workspace mismatch
      // collapses to 403.
      const authorVis = await resolveSessionVisibility(
        cfg.visibility,
        authorSessionId,
        // No user — but the agent's session has a triggered_by_user_id.
        // We re-derive that from the session itself.
        await deriveActorForAgentSession(cfg.visibility, authorSessionId),
      );
      if (
        "error" in authorVis ||
        authorVis.ok.workspaceId !== located.workspaceId
      ) {
        return c.json({ error: "thread_not_visible" }, 403);
      }

      if (
        !isCommentScope(body.scope ?? "") &&
        body.scope !== undefined &&
        body.scope !== null
      ) {
        return c.json({ error: "invalid_comment_scope" }, 400);
      }

      try {
        const result = await postShareComment(
          {
            comments: cfg.comments,
            publisher: cfg.publisher,
            resolveProducingContext: cfg.resolveProducingContext,
          },
          {
            sessionId: located.sessionId,
            workspaceId: located.workspaceId,
            shareId: located.shareId,
            shareType: located.shareType,
            threadId,
            // Replies inherit the parent thread's scope; passage replies
            // don't re-anchor.
            scope:
              body.scope && isCommentScope(body.scope)
                ? (body.scope as CommentScope)
                : "share",
            anchor: null,
            body: body.body ?? "",
            authorUserId: null,
            authorSessionId,
          },
        );
        return c.json(
          {
            comment: serialiseComment(result.comment),
            thread_id: result.threadId,
          },
          201,
        );
      } catch (err) {
        return c.json(errBody(err), statusFor(err) as 400);
      }
    }

    // ── New-thread path: session_id + share_id ─────────────────────
    if (!body.session_id || !body.share_id) {
      return c.json({ error: "missing_share_id_or_session_id" }, 400);
    }
    const sessionId = SessionId(body.session_id);
    if (sessionId !== authorSessionId) {
      // The agent can only comment on its OWN session's shares for v1
      // (anti-cross-session leak). Cross-session comments go through the
      // user-facing path with an authenticated user.
      return c.json({ error: "thread_not_visible" }, 403);
    }

    const share = await findShareInSession(
      { events: cfg.events },
      sessionId,
      body.share_id,
    );
    if (!share) return c.json({ error: "share_not_found" }, 404);
    if (!isCommentScope(body.scope ?? "")) {
      return c.json({ error: "invalid_comment_scope" }, 400);
    }

    // For agent-authored comments the workspaceId is read off the
    // session's agent — we trust the visibility helper to be the
    // canonical source.
    const actorUserId = await deriveActorForAgentSession(
      cfg.visibility,
      sessionId,
    );
    const vis = await resolveSessionVisibility(
      cfg.visibility,
      sessionId,
      actorUserId,
    );
    if ("error" in vis) return c.json({ error: "session_not_found" }, 404);

    try {
      const result = await postShareComment(
        {
          comments: cfg.comments,
          publisher: cfg.publisher,
          resolveProducingContext: cfg.resolveProducingContext,
        },
        {
          sessionId,
          workspaceId: vis.ok.workspaceId,
          shareId: body.share_id,
          shareType: share.shareType,
          scope: body.scope as CommentScope,
          anchor: body.anchor ?? null,
          body: body.body ?? "",
          authorUserId: null,
          authorSessionId,
        },
      );
      return c.json(
        {
          comment: serialiseComment(result.comment),
          thread_id: result.threadId,
        },
        201,
      );
    } catch (err) {
      return c.json(errBody(err), statusFor(err) as 400);
    }
  });

  /**
   * POST /resolve  — agent resolves (or un-resolves) a thread it can see.
   *
   * Body: `{ author_session_id, thread_id, unresolve? }`.
   *
   * Same IDOR gate as the create path — the agent's session must be in
   * the same workspace as the share that owns the supplied thread. A
   * foreign `thread_id` returns `403 thread_not_visible` without
   * leaking existence.
   */
  app.post("/resolve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      author_session_id?: string;
      thread_id?: string;
      unresolve?: boolean;
    };
    if (!body.author_session_id) {
      return c.json({ error: "missing_author_session_id" }, 400);
    }
    if (!body.thread_id) {
      return c.json({ error: "missing_thread_id" }, 400);
    }
    const authorSessionId = SessionId(body.author_session_id);
    const threadId = ShareThreadId(body.thread_id);
    const located = await cfg.comments.findThread(threadId);
    if (!located) return c.json({ error: "thread_not_found" }, 404);

    const authorVis = await resolveSessionVisibility(
      cfg.visibility,
      authorSessionId,
      await deriveActorForAgentSession(cfg.visibility, authorSessionId),
    );
    if (
      "error" in authorVis ||
      authorVis.ok.workspaceId !== located.workspaceId
    ) {
      return c.json({ error: "thread_not_visible" }, 403);
    }

    const unresolve = body.unresolve === true;
    const stamp = unresolve ? null : new Date();
    // Agent resolves don't carry a user_id — `resolved_by_user_id` is
    // null when the agent (re-)resolves. The wake-router on X1A-55
    // reads `resolved` to decide whether to skip the wake.
    await cfg.comments.setResolved(threadId, null, stamp);
    const producing = await cfg.resolveProducingContext(located.sessionId);
    await cfg.publisher.threadResolved({
      shareId: located.shareId,
      threadId,
      resolvedByUserId: null,
      workspaceId: located.workspaceId,
      sessionId: located.sessionId,
      shareType: located.shareType,
      resolved: !unresolve,
      producingSessionId: producing.producingSessionId,
      producingAgentId: producing.producingAgentId,
    });
    return c.json({
      thread_id: threadId,
      resolved_at: stamp ? stamp.toISOString() : null,
    });
  });

  return app;
}

/**
 * For an agent-authored call the "actor user id" is the session's
 * `triggered_by_user_id` — the human on whose behalf the agent runs.
 * Centralised so the IDOR check uses the same identity the workspace
 * membership table is keyed by.
 */
async function deriveActorForAgentSession(
  vis: ShareVisibilityDeps,
  sessionId: SessionId,
): Promise<UserId> {
  const s = await vis.sessions.findById(sessionId);
  if (!s || !s.triggeredByUserId) {
    // Defence in depth — the calling code already validated session
    // existence, so we should never land here. Return a sentinel that
    // can't possibly be a real user id; resolveSessionVisibility will
    // collapse to 404.
    return "00000000-0000-0000-0000-000000000000" as UserId;
  }
  return s.triggeredByUserId;
}
