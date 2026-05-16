import { describe, it, expect, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { SessionEventDTO } from "@x1agent/shared";
import { EventStream } from "../features/sessions/EventStream";

afterEach(() => {
  cleanup();
});

/**
 * Build a synthetic mixed event stream that exercises every compact
 * grouping rule: a single tool call, a run of statuses, a run of
 * tool calls, an inline text, and trailing internals (which must
 * stay hidden in compact mode).
 */
function mixedEvents(): SessionEventDTO[] {
  return [
    {
      id: "1",
      session_id: "s1",
      seq: 1,
      type: "session.started",
      payload: {},
      timestamp: "2026-01-01T00:00:00Z",
    },
    {
      id: "2",
      session_id: "s1",
      seq: 2,
      type: "session.init",
      payload: { tools: [{}, {}, {}] },
      timestamp: "2026-01-01T00:00:01Z",
    },
    {
      id: "3",
      session_id: "s1",
      seq: 3,
      type: "agent.status",
      payload: { status: "starting", detail: "Surveying orchestrator docs" },
      timestamp: "2026-01-01T00:00:02Z",
    },
    {
      id: "4",
      session_id: "s1",
      seq: 4,
      type: "agent.status",
      payload: { status: "writing", detail: "Drafting plan" },
      timestamp: "2026-01-01T00:00:03Z",
    },
    {
      id: "5",
      session_id: "s1",
      seq: 5,
      type: "agent.tool_call",
      payload: { tool_name: "Bash", input: { cmd: "ls" } },
      timestamp: "2026-01-01T00:00:04Z",
    },
    {
      id: "6",
      session_id: "s1",
      seq: 6,
      type: "agent.tool_call",
      payload: { tool_name: "Bash", input: { cmd: "pwd" } },
      timestamp: "2026-01-01T00:00:05Z",
    },
    {
      id: "7",
      session_id: "s1",
      seq: 7,
      type: "agent.tool_call",
      payload: { tool_name: "Read", input: { path: "x" } },
      timestamp: "2026-01-01T00:00:06Z",
    },
    {
      id: "8",
      session_id: "s1",
      seq: 8,
      type: "agent.tool_call",
      payload: { tool_name: "Read", input: { path: "y" } },
      timestamp: "2026-01-01T00:00:07Z",
    },
    {
      id: "9",
      session_id: "s1",
      seq: 9,
      type: "agent.text",
      payload: { text: "I'll add a commit-attribution rule." },
      timestamp: "2026-01-01T00:00:08Z",
    },
    {
      id: "10",
      session_id: "s1",
      seq: 10,
      type: "agent.tool_result",
      payload: { content: "result blob" },
      timestamp: "2026-01-01T00:00:09Z",
    },
  ];
}

describe("EventStream — default (compact) mode", () => {
  it("collapses consecutive statuses to the latest one", () => {
    const { queryByText } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    // Latest status is "Drafting plan" — earlier "Surveying ..." must
    // have been replaced in place.
    expect(queryByText(/Drafting plan/)).not.toBeNull();
    expect(queryByText(/Surveying orchestrator docs/)).toBeNull();
  });

  it("collapses a run of tool_calls into a single pill", () => {
    const { container, queryByText, queryByRole } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    // The pill text spells out the count. Tool names are NOT visible
    // until expanded — that's the whole point of the pill.
    expect(queryByText(/4 tool calls/)).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("Bash");
    expect(container.textContent ?? "").not.toContain("Read");
    // Pill is a button with aria-expanded=false until clicked.
    const pill = queryByRole("button", { name: /4 tool calls/ });
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the tool-call pill on click and reveals the underlying calls", () => {
    const { container, queryByRole } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    const pill = queryByRole("button", { name: /4 tool calls/ });
    if (!pill) throw new Error("expected tool-call pill");
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    // Tool names now visible.
    expect(container.textContent ?? "").toContain("Bash");
    expect(container.textContent ?? "").toContain("Read");
  });

  it("renders agent.text inline alongside the tool pill — chronology preserved", () => {
    const { queryByText } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    expect(queryByText(/I'll add a commit-attribution rule/)).not.toBeNull();
  });

  it("hides internal events (tool_result, session.init) in compact mode", () => {
    const { container } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    expect(container.textContent ?? "").not.toContain("session.init");
    // The tool_result blob is not rendered in compact mode.
    expect(container.textContent ?? "").not.toContain("result blob");
  });

  it("falls back to a placeholder when only internals have arrived", () => {
    const internalOnly: SessionEventDTO[] = [
      {
        id: "1",
        session_id: "s1",
        seq: 1,
        type: "session.init",
        payload: { tools: [] },
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "2",
        session_id: "s1",
        seq: 2,
        type: "agent.tool_result",
        payload: {},
        timestamp: "2026-01-01T00:00:01Z",
      },
    ];
    const { queryByText } = render(
      <EventStream
        events={internalOnly}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    expect(queryByText(/Waiting for the agent to start/)).not.toBeNull();
  });
});

describe("EventStream — platform wake pills", () => {
  function platformWakeEvents(): SessionEventDTO[] {
    return [
      {
        id: "1",
        session_id: "s1",
        seq: 1,
        type: "session.started",
        payload: {},
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "2",
        session_id: "s1",
        seq: 2,
        type: "user.message",
        payload: {
          source: "platform",
          kind: "heartbeat",
          driverless: true,
          text: "[driverless wake: heartbeat] Active children (1): worker-7. Glance at the snapshot. If there's work to do, do it. Otherwise end the turn.",
        },
        timestamp: "2026-01-01T00:00:01Z",
      },
      {
        id: "3",
        session_id: "s1",
        seq: 3,
        type: "user.message",
        payload: { text: "Hello, agent." },
        timestamp: "2026-01-01T00:00:02Z",
      },
    ];
  }

  it("renders a scheduler-wake pill collapsed by default — full payload is hidden", () => {
    const { container, queryByRole } = render(
      <EventStream
        events={platformWakeEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    const pill = queryByRole("button", { name: /scheduler tick/ });
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("aria-expanded")).toBe("false");
    // Full payload is hidden until expanded.
    expect(container.textContent ?? "").not.toContain("Active children");
    // Real user message still renders normally.
    expect(container.textContent ?? "").toContain("Hello, agent.");
  });

  it("expands the wake pill on click and reveals the full payload", () => {
    const { container, queryByRole } = render(
      <EventStream
        events={platformWakeEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    const pill = queryByRole("button", { name: /scheduler tick/ });
    if (!pill) throw new Error("expected wake pill");
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent ?? "").toContain("Active children");
  });
});

describe("EventStream — sticky-bottom scroll behavior", () => {
  /**
   * happy-dom doesn't lay out, so scrollHeight / clientHeight / scrollTop
   * default to 0. We have to forge them on the scroll container before
   * dispatching a scroll event to exercise the "user is scrolled up"
   * branch.
   */
  function forgeScroll(
    el: HTMLElement,
    metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  ) {
    Object.defineProperty(el, "scrollHeight", {
      value: metrics.scrollHeight,
      configurable: true,
    });
    Object.defineProperty(el, "scrollTop", {
      value: metrics.scrollTop,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(el, "clientHeight", {
      value: metrics.clientHeight,
      configurable: true,
    });
  }

  it("does not render the Jump-to-latest button on initial mount (user is at bottom)", () => {
    const { queryByTestId } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    expect(queryByTestId("scroll-to-latest")).toBeNull();
  });

  it("shows the Jump-to-latest button once the user scrolls up", () => {
    const { queryByTestId } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    const scrollEl = queryByTestId("event-stream-compact") as HTMLElement;
    expect(scrollEl).not.toBeNull();
    // 5000 - 100 - 500 = 4400 > 120 → "scrolled up"
    forgeScroll(scrollEl, {
      scrollHeight: 5000,
      scrollTop: 100,
      clientHeight: 500,
    });
    fireEvent.scroll(scrollEl);
    expect(queryByTestId("scroll-to-latest")).not.toBeNull();
  });

  it("clicking Jump-to-latest hides the button and snaps back to bottom", () => {
    const { queryByTestId } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    const scrollEl = queryByTestId("event-stream-compact") as HTMLElement;
    forgeScroll(scrollEl, {
      scrollHeight: 5000,
      scrollTop: 100,
      clientHeight: 500,
    });
    fireEvent.scroll(scrollEl);
    const btn = queryByTestId("scroll-to-latest");
    if (!btn) throw new Error("expected Jump-to-latest button");
    fireEvent.click(btn);
    // The click sets stick=true and atBottom=true synchronously; the
    // button must unmount as a result.
    expect(queryByTestId("scroll-to-latest")).toBeNull();
  });

  it("does not auto-scroll the container when new events arrive while the user is scrolled up", () => {
    const initial = mixedEvents();
    const { queryByTestId, rerender } = render(
      <EventStream
        events={initial}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    const scrollEl = queryByTestId("event-stream-compact") as HTMLElement;
    // Pin the user to the top of a long timeline.
    forgeScroll(scrollEl, {
      scrollHeight: 5000,
      scrollTop: 100,
      clientHeight: 500,
    });
    fireEvent.scroll(scrollEl);
    expect(scrollEl.scrollTop).toBe(100);

    // A new event lands.
    const extra: SessionEventDTO[] = [
      ...initial,
      {
        id: "11",
        session_id: "s1",
        seq: 11,
        type: "agent.text",
        payload: { text: "later message" },
        timestamp: "2026-01-01T00:00:10Z",
      },
    ];
    rerender(
      <EventStream
        events={extra}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    // scrollTop must NOT have been moved to scrollHeight — that was the
    // bug. The Jump-to-latest button stays visible so the user can opt in.
    expect(scrollEl.scrollTop).toBe(100);
    expect(queryByTestId("scroll-to-latest")).not.toBeNull();
  });
});

describe("EventStream — verbose mode", () => {
  it("renders the full event stream including internal tool calls and results", () => {
    const events = mixedEvents();
    const { container, queryByText } = render(
      <EventStream
        events={events}
        verbose
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );
    // Both status events render — history is preserved (no collapse).
    expect(queryByText(/Surveying orchestrator docs/)).not.toBeNull();
    expect(queryByText(/Drafting plan/)).not.toBeNull();
    // Tool names and tool results are visible — no pill.
    expect(container.textContent ?? "").toContain("Bash");
    expect(container.textContent ?? "").toContain("Read");
    expect(queryByText("Result")).not.toBeNull();
    // No compact pill should leak into verbose mode.
    expect(container.textContent ?? "").not.toContain("4 tool calls");
  });
});
