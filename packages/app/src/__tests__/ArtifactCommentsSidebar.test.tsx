import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ShareCommentDTO } from "@x1agent/shared";
import { ArtifactCommentsSidebar } from "../features/sessions/ArtifactCommentsSidebar";
import { useShareCommentsStore } from "../stores/shareCommentsStore";
import { useArtifactPanelStore } from "../stores/artifactPanelStore";
import { useAuthStore } from "../stores/authStore";

/**
 * X1A-105 regression suite. Three concerns under test:
 *
 *   1. Ordering — comments inside a thread render oldest-first
 *      (chronological). This was the originally-reported bug.
 *   2. Threaded layout — agent comments render at full thread-card
 *      width while user comments render in an inset bubble. The
 *      `data-author-kind` attribute is the stable hook other parts
 *      of the app (and these tests) read.
 *   3. Truncation — long comment bodies get a "See more" affordance.
 *      Short bodies don't. Just-posted-by-current-user comments
 *      bypass the clamp because the X1A-105 ticket says "don't
 *      immediately hide what they just wrote."
 *
 * The store is reset between tests so each case starts from a clean
 * slate; bypassing the `load` action lets us drive the rendered state
 * deterministically without mocking apiFetch.
 */

const SHARE_ID = "sh_test";
const SESSION_ID = "sess_test";
const WORKSPACE_SLUG = "default";
const CURRENT_USER_ID = "u_me";

const baseRow: Omit<
  ShareCommentDTO,
  "id" | "seq" | "thread_id" | "body" | "created_at"
> = {
  share_id: SHARE_ID,
  session_id: SESSION_ID,
  share_type: "document",
  scope: "share",
  anchor: null,
  author_user_id: CURRENT_USER_ID,
  author_session_id: null,
  resolved_at: null,
  resolved_by_user_id: null,
  updated_at: "2026-05-13T00:00:00.000Z",
  // X1A-110 — top-level comment by default. Tests that need a reply
  // override this via `row(..., { parent_comment_id: "..." })`.
  parent_comment_id: null,
};

function row(
  id: string,
  thread_id: string,
  seq: number,
  body: string,
  created_at: string,
  overrides: Partial<ShareCommentDTO> = {},
): ShareCommentDTO {
  return {
    ...baseRow,
    id,
    thread_id,
    seq,
    body,
    created_at,
    ...overrides,
  };
}

function seedStore(rows: ShareCommentDTO[]) {
  // Pre-populate the store and short-circuit the load() effect so the
  // component renders the seeded rows immediately on first paint.
  useShareCommentsStore.setState((s) => ({
    ...s,
    byShareId: { ...s.byShareId, [SHARE_ID]: rows },
    loading: { ...s.loading, [SHARE_ID]: false },
    errors: { ...s.errors, [SHARE_ID]: null },
    shareTypeById: { ...s.shareTypeById, [SHARE_ID]: "document" },
    // Replace load with a noop so the useEffect on mount doesn't
    // clobber our seed by issuing a real fetch.
    load: async () => {},
  }));
}

beforeEach(() => {
  useAuthStore.setState({
    user: {
      id: CURRENT_USER_ID,
      email: "me@example.com",
      name: "Me",
      avatar_url: null,
    },
    memberships: [],
    isPlatformAdmin: false,
    status: "authenticated",
    error: null,
  });
  useArtifactPanelStore.setState({ commentsCollapsed: false });
});

afterEach(() => {
  cleanup();
  // Drop seeded rows so subsequent tests don't inherit them.
  useShareCommentsStore.setState((s) => ({
    ...s,
    byShareId: {},
    loading: {},
    errors: {},
    shareTypeById: {},
  }));
});

function renderSidebar() {
  return render(
    <ArtifactCommentsSidebar
      workspaceSlug={WORKSPACE_SLUG}
      sessionId={SESSION_ID}
      shareId={SHARE_ID}
      shareType="document"
    />,
  );
}

describe("ArtifactCommentsSidebar — ordering (X1A-105)", () => {
  it("renders replies inside a thread oldest-first regardless of insert order (visible in thread-detail)", () => {
    seedStore([
      row("c2", "t1", 2, "second comment body", "2026-05-12T01:00:00Z", {
        parent_comment_id: "c1",
      }),
      row("c1", "t1", 1, "first comment body", "2026-05-12T00:00:00Z"),
      row("c3", "t1", 3, "third comment body", "2026-05-12T02:00:00Z", {
        parent_comment_id: "c1",
      }),
    ]);

    renderSidebar();
    // Replies live in thread-detail under the view-replace model. Open
    // the thread so we can assert their order.
    fireEvent.click(screen.getByTestId("thread-open"));

    const detail = screen.getByTestId("comment-thread-detail");
    const bodies = Array.from(
      detail.querySelectorAll("[data-comment-author]"),
    ).map((el) => el.textContent ?? "");

    // Seq-ascending: first, then second, then third — regardless of the
    // order they were inserted into the store.
    expect(bodies[0]).toContain("first comment body");
    expect(bodies[1]).toContain("second comment body");
    expect(bodies[2]).toContain("third comment body");
  });

  it("renders threads in chronological order — oldest thread first", () => {
    seedStore([
      row("a", "t-new", 1, "newer thread body", "2026-05-12T02:00:00Z"),
      row("b", "t-old", 1, "older thread body", "2026-05-12T00:00:00Z"),
    ]);

    renderSidebar();

    const threads = document.querySelectorAll(
      '[data-testid="comment-thread"]',
    );
    expect(threads.length).toBe(2);
    expect(threads[0]!.textContent).toContain("older thread body");
    expect(threads[1]!.textContent).toContain("newer thread body");
  });
});

describe("ArtifactCommentsSidebar — author rhythm (X1A-105)", () => {
  it("renders user and agent comments at the same full row width (slack-style); data-author-kind preserves the distinction for future styling", () => {
    // Two separate threads — one user-started, one agent-started — so
    // both rows surface in the channel view (where only top-levels show).
    seedStore([
      row("c1", "t-user", 1, "user opens thread", "2026-05-12T00:00:00Z", {
        author_user_id: CURRENT_USER_ID,
        author_session_id: null,
      }),
      row(
        "c2",
        "t-agent",
        1,
        "agent starts another thread",
        "2026-05-12T00:01:00Z",
        {
          author_user_id: null,
          author_session_id: "sess_agent",
        },
      ),
    ]);

    renderSidebar();

    const rows = Array.from(
      document.querySelectorAll("[data-author-kind]"),
    ) as HTMLElement[];

    expect(rows.length).toBe(2);
    expect(rows[0]!.getAttribute("data-author-kind")).toBe("user");
    expect(rows[1]!.getAttribute("data-author-kind")).toBe("agent");

    // Slack-style — same full-width row for both, no justify-end inset.
    expect(rows[0]!.className).toContain("w-full");
    expect(rows[1]!.className).toContain("w-full");
    expect(rows[0]!.className).not.toContain("justify-end");
  });
});

describe("ArtifactCommentsSidebar — long-comment truncation (X1A-105)", () => {
  const LONG = "x".repeat(800);

  it("renders a See more toggle for long comments and toggles to See less when clicked", () => {
    seedStore([row("c1", "t1", 1, LONG, "2026-05-12T00:00:00Z")]);

    renderSidebar();

    const toggle = screen.getByTestId("see-more-toggle");
    expect(toggle.textContent).toBe("See more");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("See less");
  });

  it("does NOT render See more for short comments", () => {
    seedStore([row("c1", "t1", 1, "tiny body", "2026-05-12T00:00:00Z")]);
    renderSidebar();
    expect(screen.queryByTestId("see-more-toggle")).toBeNull();
  });
});

// ── X1A-110 — view-replace thread detail (Slack-style) ──────────────
describe("ArtifactCommentsSidebar — view-replace thread (X1A-110)", () => {
  it("channel mode renders only the top-level of each thread; replies are hidden behind the footer", () => {
    seedStore([
      row("c1", "t1", 1, "root body", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
      row("c2", "t1", 2, "the reply body", "2026-05-12T00:01:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
        parent_comment_id: "c1",
      }),
    ]);

    renderSidebar();

    const rows = Array.from(
      document.querySelectorAll("[data-comment-id]"),
    ) as HTMLElement[];

    // Only one row visible in channel mode — the top-level. The reply
    // lives inside the thread-detail view, which we haven't opened.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-comment-id")).toBe("c1");

    // The footer reports the reply count.
    const opener = screen.getByTestId("thread-open");
    expect(opener.textContent).toContain("1 reply");
  });

  it("footer reads 'Reply' for a thread with no replies yet", () => {
    seedStore([
      row("c1", "t1", 1, "lonely root", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
    ]);
    renderSidebar();
    expect(screen.getByTestId("thread-open").textContent).toBe("Reply");
  });

  it("clicking the footer enters thread-detail; back button returns to channel mode", () => {
    seedStore([
      row("c1", "t1", 1, "the root", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
      row("c2", "t1", 2, "an earlier reply", "2026-05-12T00:01:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
        parent_comment_id: "c1",
      }),
      row("c3", "t1", 3, "a later reply", "2026-05-12T00:02:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
        parent_comment_id: "c1",
      }),
    ]);

    renderSidebar();

    // Open the thread.
    fireEvent.click(screen.getByTestId("thread-open"));

    // Detail view is up; all three comments visible, in seq order.
    const detail = screen.getByTestId("comment-thread-detail");
    const detailRows = Array.from(
      detail.querySelectorAll("[data-comment-id]"),
    ) as HTMLElement[];
    expect(detailRows.map((r) => r.getAttribute("data-comment-id"))).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    // The composer placeholder switches to reply-in-thread.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain("Reply");

    // Back button returns to channel.
    fireEvent.click(screen.getByTestId("comment-thread-back"));
    expect(screen.queryByTestId("comment-thread-detail")).toBeNull();
    expect(screen.getByTestId("comment-thread-list")).toBeTruthy();
  });

  it("thread state clears when shareId changes (no leak across share switches)", () => {
    seedStore([
      row("c1", "t1", 1, "share A root", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
    ]);

    const SHARE_B = "sh_other";
    useShareCommentsStore.setState((s) => ({
      ...s,
      byShareId: {
        ...s.byShareId,
        [SHARE_B]: [
          {
            ...baseRow,
            id: "c-b1",
            share_id: SHARE_B,
            thread_id: "t-b1",
            seq: 1,
            body: "share B root",
            created_at: "2026-05-12T01:00:00Z",
            author_user_id: null,
            author_session_id: "sess_agent",
          },
        ],
      },
      loading: { ...s.loading, [SHARE_B]: false },
      errors: { ...s.errors, [SHARE_B]: null },
      shareTypeById: { ...s.shareTypeById, [SHARE_B]: "document" },
    }));

    const { rerender } = render(
      <ArtifactCommentsSidebar
        workspaceSlug={WORKSPACE_SLUG}
        sessionId={SESSION_ID}
        shareId={SHARE_ID}
        shareType="document"
      />,
    );

    // Open the thread on share A.
    fireEvent.click(screen.getByTestId("thread-open"));
    expect(screen.getByTestId("comment-thread-detail")).toBeTruthy();

    // Half-typed draft in the in-thread composer.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "half-typed reply" } });

    rerender(
      <ArtifactCommentsSidebar
        workspaceSlug={WORKSPACE_SLUG}
        sessionId={SESSION_ID}
        shareId={SHARE_B}
        shareType="document"
      />,
    );

    // Snap-back to channel mode for share B, draft cleared.
    expect(screen.queryByTestId("comment-thread-detail")).toBeNull();
    expect(screen.getByTestId("comment-thread-list")).toBeTruthy();
    const textareaB = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textareaB.value).toBe("");
  });
});
