import { describe, expect, it } from "bun:test";
import type { ShareCommentDTO } from "@x1agent/shared";
import {
  groupThreads,
  unresolvedThreadCount,
} from "../stores/shareCommentsStore";

const base: Omit<ShareCommentDTO, "id" | "seq" | "thread_id" | "body"> = {
  share_id: "sh1",
  session_id: "s1",
  share_type: "document",
  scope: "share",
  anchor: null,
  author_user_id: "u1",
  author_session_id: null,
  resolved_at: null,
  resolved_by_user_id: null,
  created_at: "2026-05-12T00:00:00.000Z",
  updated_at: "2026-05-12T00:00:00.000Z",
};

function comment(
  id: string,
  thread_id: string,
  seq: number,
  body: string,
  overrides: Partial<ShareCommentDTO> = {},
): ShareCommentDTO {
  return { ...base, id, thread_id, seq, body, ...overrides };
}

describe("groupThreads", () => {
  it("groups rows by thread_id with comments seq-ordered within each thread", () => {
    const rows: ShareCommentDTO[] = [
      comment("c2", "t1", 2, "reply"),
      comment("c1", "t1", 1, "first"),
      comment("c3", "t2", 1, "other thread"),
    ];
    const threads = groupThreads(rows);
    const t1 = threads.find((t) => t.thread_id === "t1")!;
    expect(t1.comments.map((c) => c.seq)).toEqual([1, 2]);
    expect(threads).toHaveLength(2);
  });

  it("coalesces resolved_at from the head row", () => {
    const rows: ShareCommentDTO[] = [
      comment("c1", "t1", 1, "head", {
        resolved_at: "2026-05-12T00:01:00.000Z",
      }),
      comment("c2", "t1", 2, "reply", {
        resolved_at: "2026-05-12T00:01:00.000Z",
      }),
    ];
    const [thread] = groupThreads(rows);
    expect(thread!.resolved_at).toBe("2026-05-12T00:01:00.000Z");
  });

  it("returns threads in chronological order — oldest at top, newest at bottom (X1A-105)", () => {
    const rows: ShareCommentDTO[] = [
      comment("a", "t-old", 1, "old", {
        created_at: "2026-05-10T00:00:00.000Z",
      }),
      comment("b", "t-new", 1, "new", {
        created_at: "2026-05-12T00:00:00.000Z",
      }),
    ];
    const ids = groupThreads(rows).map((t) => t.thread_id);
    // Oldest thread first; newest at the bottom. Matches the
    // chat-timeline reading direction (no scroll-up to see new).
    expect(ids).toEqual(["t-old", "t-new"]);
  });

  it("interleaves mixed user/agent authorship without reordering by author", () => {
    const rows: ShareCommentDTO[] = [
      comment("u1", "t1", 1, "user opens thread", {
        author_user_id: "u1",
        author_session_id: null,
      }),
      comment("a1", "t1", 2, "agent replies", {
        author_user_id: null,
        author_session_id: "s1",
      }),
      comment("u2", "t1", 3, "user follows up", {
        author_user_id: "u1",
        author_session_id: null,
      }),
    ];
    const [thread] = groupThreads(rows);
    expect(thread!.comments.map((c) => c.id)).toEqual(["u1", "a1", "u2"]);
  });
});

describe("unresolvedThreadCount", () => {
  it("ignores resolved threads", () => {
    const rows: ShareCommentDTO[] = [
      comment("c1", "t1", 1, "hi"),
      comment("c2", "t2", 1, "done", {
        resolved_at: "2026-05-12T00:01:00.000Z",
      }),
      comment("c3", "t3", 1, "open"),
    ];
    expect(unresolvedThreadCount(rows)).toBe(2);
  });

  it("returns 0 when no rows exist", () => {
    expect(unresolvedThreadCount([])).toBe(0);
  });
});
