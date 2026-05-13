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
  it("renders replies inside a thread oldest-first regardless of insert order", () => {
    seedStore([
      row("c2", "t1", 2, "second comment body", "2026-05-12T01:00:00Z"),
      row("c1", "t1", 1, "first comment body", "2026-05-12T00:00:00Z"),
      row("c3", "t1", 3, "third comment body", "2026-05-12T02:00:00Z"),
    ]);

    renderSidebar();

    const bodies = Array.from(
      document.querySelectorAll("[data-comment-author]"),
    ).map((el) => el.textContent ?? "");

    // The first rendered row's body contains "first", the next "second",
    // the last "third" — proves seq-ascending order regardless of how
    // rows were inserted into the store.
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
  it("marks agent comments as full-width and user comments as inset", () => {
    seedStore([
      row("c1", "t1", 1, "user opens thread", "2026-05-12T00:00:00Z", {
        author_user_id: CURRENT_USER_ID,
        author_session_id: null,
      }),
      row("c2", "t1", 2, "agent replies in full width", "2026-05-12T00:01:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
    ]);

    renderSidebar();

    const rows = Array.from(
      document.querySelectorAll("[data-author-kind]"),
    ) as HTMLElement[];

    expect(rows.length).toBe(2);
    // Order matches the chronological render order from the test
    // above — first row is the user, second is the agent.
    expect(rows[0]!.getAttribute("data-author-kind")).toBe("user");
    expect(rows[1]!.getAttribute("data-author-kind")).toBe("agent");

    // The class hooks let the rest of the app (and the visual
    // designer reading the DOM in devtools) tell the two apart.
    // User rows live inside a `flex justify-end` parent so the
    // inset bubble sits to the right; agent rows render as a
    // block at full width.
    expect(rows[0]!.className).toContain("justify-end");
    expect(rows[1]!.className).toContain("w-full");
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

// ── X1A-110 — reply-nesting affordance + indent ──────────────────────
describe("ArtifactCommentsSidebar — reply nesting (X1A-110)", () => {
  it("renders a reply at the depth-1 indent under its parent", () => {
    seedStore([
      row("c1", "t1", 1, "root body", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent", // agent → full-width row
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

    expect(rows).toHaveLength(2);
    // Root row has no indent.
    expect(rows[0]!.getAttribute("data-is-reply")).toBe("false");
    expect(rows[0]!.style.marginLeft).toBe("");
    // Reply row carries the ~20px indent.
    expect(rows[1]!.getAttribute("data-is-reply")).toBe("true");
    expect(rows[1]!.style.marginLeft).toBe("20px");
  });

  it("renders a Reply button on top-level rows and HIDES it on replies (depth-1 cap)", () => {
    seedStore([
      row("c1", "t1", 1, "root", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
      row("c2", "t1", 2, "reply", "2026-05-12T00:01:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
        parent_comment_id: "c1",
      }),
    ]);

    renderSidebar();

    const replyButtons = screen.queryAllByTestId("reply-button");
    // Only the root has a Reply affordance — a reply itself cannot be
    // replied to in v1 (server would 400 `nested_reply_not_supported`).
    expect(replyButtons).toHaveLength(1);
  });

  it("clicking Reply opens the chip, X clears it", () => {
    seedStore([
      row("c1", "t1", 1, "root", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
    ]);

    renderSidebar();

    // No chip before the user clicks Reply.
    expect(screen.queryByTestId("reply-target-chip")).toBeNull();

    fireEvent.click(screen.getByTestId("reply-button"));

    const chip = screen.getByTestId("reply-target-chip");
    expect(chip.textContent).toContain("Replying to");
    expect(chip.textContent).toContain("root");

    fireEvent.click(screen.getByTestId("reply-target-clear"));
    expect(screen.queryByTestId("reply-target-chip")).toBeNull();
  });

  it("reply target clears when shareId changes (no leak across share switches)", () => {
    // Share A: seed a root comment so we can open a reply target.
    seedStore([
      row("c1", "t1", 1, "share A root", "2026-05-12T00:00:00Z", {
        author_user_id: null,
        author_session_id: "sess_agent",
      }),
    ]);

    // Also seed share B with a different root so the rerender renders
    // something — proves the component remounted in a sensible state.
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

    // Open a reply target on share A.
    fireEvent.click(screen.getByTestId("reply-button"));
    expect(screen.getByTestId("reply-target-chip")).toBeTruthy();

    // Drop unsent draft text into the composer so we can prove it
    // clears too. The composer renders a textarea via ComposerShell.
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "half-typed reply" } });
    expect(textarea.value).toBe("half-typed reply");

    // Navigate the sidebar to share B without unmounting — the same
    // shape as closing share A's flyout and opening share B's while
    // the ArtifactPanel stays mounted.
    rerender(
      <ArtifactCommentsSidebar
        workspaceSlug={WORKSPACE_SLUG}
        sessionId={SESSION_ID}
        shareId={SHARE_B}
        shareType="document"
      />,
    );

    // Reply chip and draft both gone — composer state was per-share.
    expect(screen.queryByTestId("reply-target-chip")).toBeNull();
    const textareaB = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textareaB).toBeTruthy();
    expect(textareaB.value).toBe("");
  });
});
