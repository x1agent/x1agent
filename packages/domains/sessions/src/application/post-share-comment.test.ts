import { describe, expect, it } from "bun:test";
import { UserId } from "@x1agent/kernel";
import { SessionId } from "../domain/session.js";
import {
  NestedReplyNotSupportedError,
  ParentCommentNotInThreadError,
  ShareCommentId,
  ShareThreadId,
  ShareTypeNotCommentableError,
  type CommentScope,
  type PassageAnchor,
  type ShareComment,
} from "../domain/share-comment.js";
import type {
  AppendShareCommentInput,
  ShareCommentRepository,
  ThreadLocator,
} from "../ports/share-comment-repository.js";
import { RecordingShareCommentPublisher } from "../adapters/nats/nats-share-comment-publisher.js";
import { postShareComment } from "./post-share-comment.js";
import { resolveShareThread } from "./resolve-share-thread.js";
import {
  ThreadNotVisibleError,
  ThreadNotFoundError,
} from "../domain/share-comment.js";

/**
 * Append-only fake. Mirrors the Postgres adapter's behaviour: each
 * append picks max(seq)+1 within a (share, thread), and the resolve
 * fans across the thread's rows.
 */
class FakeShareCommentRepository implements ShareCommentRepository {
  rows: ShareComment[] = [];

  async append(input: AppendShareCommentInput): Promise<ShareComment> {
    const within = this.rows.filter(
      (r) => r.shareId === input.shareId && r.threadId === input.threadId,
    );
    const seq = within.length === 0 ? 1 : Math.max(...within.map((r) => r.seq)) + 1;
    const c: ShareComment = {
      id: ShareCommentId(`c${this.rows.length + 1}`),
      shareId: input.shareId,
      threadId: input.threadId,
      seq,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      shareType: input.shareType,
      commentScope: input.commentScope,
      anchorJson: input.anchorJson,
      body: input.body,
      authorUserId: input.authorUserId,
      authorSessionId: input.authorSessionId,
      resolvedAt: null,
      resolvedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      parentCommentId: input.parentCommentId,
    };
    this.rows.push(c);
    return c;
  }

  async listByShare(sessionId: SessionId, shareId: string) {
    return this.rows.filter(
      (r) => r.sessionId === sessionId && r.shareId === shareId,
    );
  }

  async findThread(threadId: ShareThreadId): Promise<ThreadLocator | null> {
    const rows = this.rows.filter((r) => r.threadId === threadId);
    if (rows.length === 0) return null;
    const head = rows.reduce((a, b) => (a.seq < b.seq ? a : b));
    return {
      shareId: head.shareId,
      sessionId: head.sessionId,
      workspaceId: head.workspaceId,
      shareType: head.shareType,
      resolvedAt: head.resolvedAt,
      resolvedByUserId: head.resolvedByUserId,
      firstSeq: head.seq,
    };
  }

  async findOne(shareId: string, threadId: ShareThreadId, seq: number) {
    return (
      this.rows.find(
        (r) =>
          r.shareId === shareId && r.threadId === threadId && r.seq === seq,
      ) ?? null
    );
  }

  async findById(id: ShareCommentId) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async updateBody(id: string, body: string) {
    const r = this.rows.find((r) => r.id === id);
    if (!r) return null;
    r.body = body;
    r.updatedAt = new Date();
    return r;
  }

  async remove(id: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }

  async setResolved(
    threadId: ShareThreadId,
    resolvedBy: UserId | null,
    resolvedAt: Date | null,
  ) {
    for (const r of this.rows) {
      if (r.threadId === threadId) {
        r.resolvedAt = resolvedAt;
        r.resolvedByUserId = resolvedBy;
      }
    }
  }

  async countThreadsByShare(sessionId: SessionId, shareId: string) {
    return new Set(
      this.rows
        .filter((r) => r.sessionId === sessionId && r.shareId === shareId)
        .map((r) => r.threadId),
    ).size;
  }
}

const SESSION_A = SessionId("11111111-1111-1111-1111-111111111111");
const WS_A = "ws-a";
const AGENT_A = "agent-a";

const producing = async (sessionId: SessionId) => ({
  producingSessionId: sessionId,
  producingAgentId: AGENT_A,
});

describe("postShareComment", () => {
  it("opens a thread, emits NATS event with producing_*", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    const result = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "document",
        scope: "share",
        anchor: null,
        body: "hello",
        authorUserId: UserId("11111111-1111-1111-1111-111111111111"),
        authorSessionId: null,
      },
    );
    expect(result.comment.seq).toBe(1);
    expect(result.threadId).toBeTruthy();
    expect(publisher.added).toHaveLength(1);
    expect(publisher.added[0]!.producingSessionId).toBe(SESSION_A);
    expect(publisher.added[0]!.producingAgentId).toBe(AGENT_A);
    expect(publisher.added[0]!.body).toBe("hello");
    expect(publisher.added[0]!.shareId).toBe("sh1");
  });

  it("reply gets seq=2 in the same thread", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    const first = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        scope: "share",
        anchor: null,
        body: "first",
        authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
        authorSessionId: null,
      },
    );
    const second = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        threadId: first.threadId,
        scope: "share",
        anchor: null,
        body: "reply",
        authorUserId: UserId("33333333-3333-3333-3333-333333333333"),
        authorSessionId: null,
      },
    );
    expect(second.comment.seq).toBe(2);
    expect(second.threadId).toBe(first.threadId);
  });

  it("rejects passage scope on a non-markdown share", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    await expect(
      postShareComment(
        { comments, publisher, resolveProducingContext: producing },
        {
          sessionId: SESSION_A,
          workspaceId: WS_A,
          shareId: "sh1",
          shareType: "site",
          scope: "passage",
          anchor: {
            selection: {
              start_line: 0,
              start_col: 0,
              end_line: 0,
              end_col: 1,
              quoted_text: "x",
            },
          } satisfies PassageAnchor,
          body: "x",
          authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
          authorSessionId: null,
        } as never,
      ),
    ).rejects.toThrow();
  });

  // ── X1A-110 — reply nesting ────────────────────────────────────
  it("persists parentCommentId on a reply (top-level → reply)", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    const root = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        scope: "share",
        anchor: null,
        body: "root",
        authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
        authorSessionId: null,
      },
    );
    const reply = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        threadId: root.threadId,
        scope: "share",
        anchor: null,
        body: "reply",
        authorUserId: UserId("33333333-3333-3333-3333-333333333333"),
        authorSessionId: null,
        parentCommentId: root.comment.id,
      },
    );
    expect(reply.comment.parentCommentId).toBe(root.comment.id);
    expect(reply.comment.threadId).toBe(root.comment.threadId);
  });

  it("rejects reply-to-reply (depth-1 cap)", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    const root = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        scope: "share",
        anchor: null,
        body: "root",
        authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
        authorSessionId: null,
      },
    );
    const reply = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        threadId: root.threadId,
        scope: "share",
        anchor: null,
        body: "reply",
        authorUserId: UserId("33333333-3333-3333-3333-333333333333"),
        authorSessionId: null,
        parentCommentId: root.comment.id,
      },
    );
    // Now try to reply to the reply.
    await expect(
      postShareComment(
        { comments, publisher, resolveProducingContext: producing },
        {
          sessionId: SESSION_A,
          workspaceId: WS_A,
          shareId: "sh1",
          shareType: "site",
          threadId: root.threadId,
          scope: "share",
          anchor: null,
          body: "reply to reply",
          authorUserId: UserId("44444444-4444-4444-4444-444444444444"),
          authorSessionId: null,
          parentCommentId: reply.comment.id,
        },
      ),
    ).rejects.toBeInstanceOf(NestedReplyNotSupportedError);
  });

  it("rejects cross-thread parent (parent lives in a different thread)", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    const threadA = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        scope: "share",
        anchor: null,
        body: "A root",
        authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
        authorSessionId: null,
      },
    );
    const threadB = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        scope: "share",
        anchor: null,
        body: "B root",
        authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
        authorSessionId: null,
      },
    );
    // Reply in thread B with a parent that belongs to thread A.
    await expect(
      postShareComment(
        { comments, publisher, resolveProducingContext: producing },
        {
          sessionId: SESSION_A,
          workspaceId: WS_A,
          shareId: "sh1",
          shareType: "site",
          threadId: threadB.threadId,
          scope: "share",
          anchor: null,
          body: "x",
          authorUserId: UserId("33333333-3333-3333-3333-333333333333"),
          authorSessionId: null,
          parentCommentId: threadA.comment.id,
        },
      ),
    ).rejects.toBeInstanceOf(ParentCommentNotInThreadError);
  });

  it("rejects parent_comment_id without thread_id (can't reply while opening a new thread)", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    await expect(
      postShareComment(
        { comments, publisher, resolveProducingContext: producing },
        {
          sessionId: SESSION_A,
          workspaceId: WS_A,
          shareId: "sh1",
          shareType: "site",
          scope: "share",
          anchor: null,
          body: "x",
          authorUserId: UserId("33333333-3333-3333-3333-333333333333"),
          authorSessionId: null,
          parentCommentId: ShareCommentId(
            "11111111-1111-1111-1111-111111111111",
          ),
        },
      ),
    ).rejects.toBeInstanceOf(ParentCommentNotInThreadError);
  });

  it("rejects parent_comment_id pointing at a non-existent comment", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    const root = await postShareComment(
      { comments, publisher, resolveProducingContext: producing },
      {
        sessionId: SESSION_A,
        workspaceId: WS_A,
        shareId: "sh1",
        shareType: "site",
        scope: "share",
        anchor: null,
        body: "root",
        authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
        authorSessionId: null,
      },
    );
    await expect(
      postShareComment(
        { comments, publisher, resolveProducingContext: producing },
        {
          sessionId: SESSION_A,
          workspaceId: WS_A,
          shareId: "sh1",
          shareType: "site",
          threadId: root.threadId,
          scope: "share",
          anchor: null,
          body: "x",
          authorUserId: UserId("33333333-3333-3333-3333-333333333333"),
          authorSessionId: null,
          parentCommentId: ShareCommentId("does-not-exist"),
        },
      ),
    ).rejects.toBeInstanceOf(ParentCommentNotInThreadError);
  });

  it("rejects non-commentable share types", async () => {
    const comments = new FakeShareCommentRepository();
    const publisher = new RecordingShareCommentPublisher();
    await expect(
      postShareComment(
        { comments, publisher, resolveProducingContext: producing },
        {
          sessionId: SESSION_A,
          workspaceId: WS_A,
          shareId: "sh1",
          shareType: "image",
          scope: "share",
          anchor: null,
          body: "x",
          authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
          authorSessionId: null,
        } as never,
      ),
    ).rejects.toThrow(ShareTypeNotCommentableError);
  });
});

describe("resolveShareThread (IDOR guard)", () => {
  it("matches thread to share, returns 200 when caller can see session", async () => {
    const comments = new FakeShareCommentRepository();
    const t = ShareThreadId("t1");
    await comments.append({
      shareId: "sh1",
      threadId: t,
      sessionId: SESSION_A,
      workspaceId: WS_A,
      shareType: "document",
      commentScope: "share",
      anchorJson: null,
      body: "x",
      authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
      authorSessionId: null,
    });
    const out = await resolveShareThread(
      { comments, canSeeSession: async () => true },
      t,
      "sh1",
    );
    expect(out.shareId).toBe("sh1");
    expect(out.sessionId).toBe(SESSION_A);
  });

  it("rejects when thread_id belongs to a different share than the URL claims (prompt injection)", async () => {
    const comments = new FakeShareCommentRepository();
    const t = ShareThreadId("t1");
    await comments.append({
      shareId: "sh-other",
      threadId: t,
      sessionId: SESSION_A,
      workspaceId: WS_A,
      shareType: "document",
      commentScope: "share",
      anchorJson: null,
      body: "x",
      authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
      authorSessionId: null,
    });
    await expect(
      resolveShareThread(
        { comments, canSeeSession: async () => true },
        t,
        "sh-claimed",
      ),
    ).rejects.toThrow(ThreadNotVisibleError);
  });

  it("rejects when caller can't see the session (cross-tenant)", async () => {
    const comments = new FakeShareCommentRepository();
    const t = ShareThreadId("t1");
    await comments.append({
      shareId: "sh1",
      threadId: t,
      sessionId: SESSION_A,
      workspaceId: WS_A,
      shareType: "document",
      commentScope: "share",
      anchorJson: null,
      body: "x",
      authorUserId: UserId("22222222-2222-2222-2222-222222222222"),
      authorSessionId: null,
    });
    await expect(
      resolveShareThread(
        { comments, canSeeSession: async () => false },
        t,
        "sh1",
      ),
    ).rejects.toThrow(ThreadNotVisibleError);
  });

  it("rejects when thread_id doesn't exist", async () => {
    const comments = new FakeShareCommentRepository();
    await expect(
      resolveShareThread(
        { comments, canSeeSession: async () => true },
        ShareThreadId("not-real"),
      ),
    ).rejects.toThrow(ThreadNotFoundError);
  });
});
