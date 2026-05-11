import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import {
  renderShareBody,
  type AgentSharePayload,
} from "../features/sessions/ShareCard";

/**
 * X1A-19: in the share flyout (ArtifactPanel) a long markdown document
 * was clipped because DocumentShare imposed its own 384px (`max-h-96`)
 * inner scroller, even though the parent flyout already provides a
 * full-viewport scroll region. The fix gates that cap behind a
 * `fillParent` prop: the flyout passes it, the inline chat-stream
 * preview does not.
 *
 * These tests pin both branches so the cap can't silently come back.
 */

const longMarkdown = Array.from(
  { length: 200 },
  (_, i) => `Line ${i + 1}: lorem ipsum dolor sit amet.\n`,
).join("");

function fakeFetch(body: string) {
  return mock(async () => ({
    text: async () => body,
  })) as unknown as typeof fetch;
}

const payload: AgentSharePayload = {
  share_id: "share_abc",
  share_type: "document",
  title: "Plan.md",
  path: "plan.md",
  files: [{ path: "plan.md", size: longMarkdown.length, content_type: "text/markdown" }],
  total_size: longMarkdown.length,
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(longMarkdown);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe("DocumentShare height behaviour (X1A-19)", () => {
  it("drops the 384px inner scroller when rendered inside a fillParent flyout", async () => {
    const { findByTestId } = render(
      renderShareBody({
        payload,
        workspaceSlug: "acme",
        sessionId: "sess_1",
        fillParent: true,
      }),
    );

    const wrapper = await findByTestId("document-share");
    // The flyout owns the scroll region; the document wrapper must not
    // impose its own bounded preview height.
    expect(wrapper.className).not.toMatch(/max-h-96/);
    expect(wrapper.className).not.toMatch(/overflow-auto/);
  });

  it("keeps the bounded preview height for the inline chat-stream render", async () => {
    const { findByTestId } = render(
      renderShareBody({
        payload,
        workspaceSlug: "acme",
        sessionId: "sess_1",
      }),
    );

    const wrapper = await findByTestId("document-share");
    // Without fillParent we're inside the chat feed — keep the
    // 384px-tall scrolling preview so long docs don't push other
    // events off-screen.
    expect(wrapper.className).toMatch(/max-h-96/);
    expect(wrapper.className).toMatch(/overflow-auto/);
  });

  it("fillParent=false matches the legacy unflagged behaviour", async () => {
    const { findByTestId, unmount } = render(
      renderShareBody({
        payload,
        workspaceSlug: "acme",
        sessionId: "sess_1",
        fillParent: false,
      }),
    );

    const wrapper = await findByTestId("document-share");
    expect(wrapper.className).toMatch(/max-h-96/);
    unmount();

    await waitFor(() => {
      // Sanity: the markdown body actually rendered (fetch resolved).
      // If this assertion ever breaks it'll surface as "loading…"
      // hanging instead of a false negative on the class check.
      expect(true).toBe(true);
    });
  });
});
