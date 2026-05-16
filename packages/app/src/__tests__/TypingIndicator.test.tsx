import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import {
  MainTimelineTypingIndicators,
  ThreadTypingIndicators,
} from "../features/sessions/TypingIndicator";
import { useTypingIndicatorStore } from "../stores/typingIndicatorStore";

const SESSION = "session-a";

function reset() {
  useTypingIndicatorStore.setState({ bySession: {} });
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe("MainTimelineTypingIndicators", () => {
  it("renders nothing when no indicators are active", () => {
    const { queryByRole, container } = render(
      <MainTimelineTypingIndicators sessionId={SESSION} />,
    );
    expect(queryByRole("status")).toBeNull();
    // Component returns null — host fragment has no children
    expect(container.firstChild).toBeNull();
  });

  it("renders a pill for an active main-scoped indicator (share_id+thread_id both null)", () => {
    useTypingIndicatorStore.getState().add(SESSION, {
      event_id: "wake-1",
      share_id: null,
      thread_id: null,
      started_at: new Date(Date.now()).toISOString(),
      wake_source: "user",
    });
    const { queryByRole, queryByText } = render(
      <MainTimelineTypingIndicators sessionId={SESSION} />,
    );
    const status = queryByRole("status");
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(queryByText("agent is thinking")).not.toBeNull();
  });

  it("ignores thread-scoped indicators — they must never bubble into the main timeline", () => {
    useTypingIndicatorStore.getState().add(SESSION, {
      event_id: "wake-thread",
      share_id: "share-1",
      thread_id: "thread-1",
      started_at: new Date(Date.now()).toISOString(),
      wake_source: "share_comment",
    });
    const { queryByRole } = render(
      <MainTimelineTypingIndicators sessionId={SESSION} />,
    );
    expect(queryByRole("status")).toBeNull();
  });

  it("collapses overlapping main-scoped wakes into a single pill", () => {
    // Reported regression: two concurrent main wakes rendered as two
    // pill stacks, which read as duplicate UI. The store still tracks
    // each wake (so per-wake clear correlation keeps working), but
    // the surface only shows one set of dots regardless of how many
    // are in flight.
    const started = new Date(Date.now()).toISOString();
    useTypingIndicatorStore.getState().add(SESSION, {
      event_id: "wake-a",
      share_id: null,
      thread_id: null,
      started_at: started,
      wake_source: "user",
    });
    useTypingIndicatorStore.getState().add(SESSION, {
      event_id: "wake-b",
      share_id: null,
      thread_id: null,
      started_at: started,
      wake_source: "scheduler",
    });
    const { container } = render(
      <MainTimelineTypingIndicators sessionId={SESSION} />,
    );
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
  });
});

describe("ThreadTypingIndicators", () => {
  it("renders only when an indicator matches share_id+thread_id", () => {
    useTypingIndicatorStore.getState().add(SESSION, {
      event_id: "wake-1",
      share_id: "share-1",
      thread_id: "thread-1",
      started_at: new Date(Date.now()).toISOString(),
      wake_source: "share_comment",
    });
    // Match
    const { queryByRole, unmount } = render(
      <ThreadTypingIndicators
        sessionId={SESSION}
        shareId="share-1"
        threadId="thread-1"
      />,
    );
    expect(queryByRole("status")).not.toBeNull();
    unmount();

    // Different thread — no render
    const { queryByRole: q2 } = render(
      <ThreadTypingIndicators
        sessionId={SESSION}
        shareId="share-1"
        threadId="thread-OTHER"
      />,
    );
    expect(q2("status")).toBeNull();
  });

  it("does not render when the indicator is main-scoped (share_id null)", () => {
    useTypingIndicatorStore.getState().add(SESSION, {
      event_id: "wake-main",
      share_id: null,
      thread_id: null,
      started_at: new Date(Date.now()).toISOString(),
      wake_source: "user",
    });
    const { queryByRole } = render(
      <ThreadTypingIndicators
        sessionId={SESSION}
        shareId="share-1"
        threadId="thread-1"
      />,
    );
    expect(queryByRole("status")).toBeNull();
  });
});

describe("indicator clears", () => {
  it("disappears when clearByEventId is called for its event_id", () => {
    useTypingIndicatorStore.getState().add(SESSION, {
      event_id: "wake-1",
      share_id: null,
      thread_id: null,
      started_at: new Date(Date.now()).toISOString(),
      wake_source: "user",
    });
    const { queryByRole, rerender } = render(
      <MainTimelineTypingIndicators sessionId={SESSION} />,
    );
    expect(queryByRole("status")).not.toBeNull();
    useTypingIndicatorStore.getState().clearByEventId(SESSION, "wake-1");
    rerender(<MainTimelineTypingIndicators sessionId={SESSION} />);
    expect(queryByRole("status")).toBeNull();
  });
});
