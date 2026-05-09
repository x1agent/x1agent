import { describe, it, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import type { SessionEventDTO } from "@x1agent/shared";
import { EventStream } from "../features/sessions/EventStream";

afterEach(() => {
  cleanup();
});

/**
 * Build a synthetic mixed event stream that exercises both "public"
 * and "internal" event categories. Order matters — the latest public
 * event in the stream is the one we assert renders in default mode.
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
      type: "agent.tool_call",
      payload: { tool_name: "ToolSearch", input: { query: "graph" } },
      timestamp: "2026-01-01T00:00:03Z",
    },
    {
      id: "5",
      session_id: "s1",
      seq: 5,
      type: "agent.tool_result",
      payload: { content: "result blob" },
      timestamp: "2026-01-01T00:00:04Z",
    },
    {
      id: "6",
      session_id: "s1",
      seq: 6,
      type: "agent.status",
      payload: { status: "writing", detail: "Drafting plan" },
      timestamp: "2026-01-01T00:00:05Z",
    },
    {
      id: "7",
      session_id: "s1",
      seq: 7,
      type: "agent.tool_call",
      payload: { tool_name: "ToolSearch", input: { query: "events" } },
      timestamp: "2026-01-01T00:00:06Z",
    },
  ];
}

describe("EventStream — default (compact) mode", () => {
  it("renders only the latest public event between two dividers", () => {
    const { container, queryByText } = render(
      <EventStream
        events={mixedEvents()}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );

    const dividers = container.querySelectorAll(
      '[data-testid="timeline-divider"]',
    );
    expect(dividers.length).toBe(2);

    // Latest public event is the second `agent.status` ("Drafting plan").
    expect(queryByText(/Drafting plan/)).not.toBeNull();
    // Earlier status entry must not render — it has been REPLACED.
    expect(queryByText(/Surveying orchestrator docs/)).toBeNull();
    // Internal event types stay hidden in default mode. ToolSearch
    // calls and tool results do not appear; the noisy stream is gone.
    expect(container.textContent ?? "").not.toContain("ToolSearch");
    expect(container.textContent ?? "").not.toContain("Result");
  });

  it("falls back to a placeholder when no public events have arrived", () => {
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
        type: "agent.tool_call",
        payload: { tool_name: "ToolSearch", input: {} },
        timestamp: "2026-01-01T00:00:01Z",
      },
    ];
    const { container, queryByText } = render(
      <EventStream
        events={internalOnly}
        verbose={false}
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );

    const dividers = container.querySelectorAll(
      '[data-testid="timeline-divider"]',
    );
    expect(dividers.length).toBe(2);
    expect(queryByText(/Waiting for the agent to start/)).not.toBeNull();
  });
});

describe("EventStream — verbose mode", () => {
  it("renders the full event stream including internal tool calls", () => {
    const events = mixedEvents();
    const { container, queryByText } = render(
      <EventStream
        events={events}
        verbose
        workspaceSlug="ws"
        sessionId="s1"
      />,
    );

    // No compact dividers — verbose mode is the regular event stream.
    const dividers = container.querySelectorAll(
      '[data-testid="timeline-divider"]',
    );
    expect(dividers.length).toBe(0);

    // Both status events render — history is preserved.
    expect(queryByText(/Surveying orchestrator docs/)).not.toBeNull();
    expect(queryByText(/Drafting plan/)).not.toBeNull();

    // Internal tool calls and results that were hidden in default
    // mode now show up. The ToolSearch tool name appears verbatim.
    expect(container.textContent ?? "").toContain("ToolSearch");
    // Tool results render as collapsed "Result" affordances in verbose.
    expect(queryByText("Result")).not.toBeNull();
  });
});
