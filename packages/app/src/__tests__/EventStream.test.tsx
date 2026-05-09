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
