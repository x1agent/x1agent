import { describe, it, expect, beforeEach } from "bun:test";
import {
  countActiveWorkers,
  formatWorkersLabel,
  sortChildrenForFlyout,
  type ChildWorker,
} from "../features/sessions/childWorkers";
import {
  childrenAfterEvent,
  useSessionDetailStore,
  type ChildRef,
} from "../stores/sessionDetailStore";
import type { SessionEventDTO } from "@x1agent/shared";

const SESSION_ID = "ses-parent";

function child(overrides: Partial<ChildWorker> = {}): ChildWorker {
  return {
    id: overrides.id ?? "ses-child-a",
    status: overrides.status ?? "running",
    triggered_at: overrides.triggered_at ?? "2026-05-09T12:00:00.000Z",
    agent: overrides.agent ?? {
      id: "agt-1",
      slug: "worker-bot",
      name: "Worker Bot",
    },
  };
}

beforeEach(() => {
  useSessionDetailStore.setState({
    sessionsById: {},
    agentsBySession: {},
    parentBySession: {},
    childrenBySession: {},
    eventsBySession: {},
    statusBySession: {},
    errorBySession: {},
  });
});

describe("countActiveWorkers", () => {
  it("counts only pending + running children", () => {
    const list: ChildWorker[] = [
      child({ id: "a", status: "running" }),
      child({ id: "b", status: "pending" }),
      child({ id: "c", status: "complete" }),
      child({ id: "d", status: "failed" }),
    ];
    expect(countActiveWorkers(list)).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(countActiveWorkers([])).toBe(0);
  });
});

describe("formatWorkersLabel", () => {
  it("renders empty-state copy when no workers are active", () => {
    expect(formatWorkersLabel(0)).toBe("No active workers");
  });

  it("uses singular form for exactly one worker", () => {
    expect(formatWorkersLabel(1)).toBe("1 child session running");
  });

  it("uses plural form for >1 worker", () => {
    expect(formatWorkersLabel(2)).toBe("2 child sessions running");
    expect(formatWorkersLabel(7)).toBe("7 child sessions running");
  });
});

describe("sortChildrenForFlyout", () => {
  it("places active children before terminal ones, newest first within each bucket", () => {
    const list: ChildWorker[] = [
      child({ id: "old-complete", status: "complete", triggered_at: "2026-05-08T00:00:00Z" }),
      child({ id: "new-complete", status: "complete", triggered_at: "2026-05-09T00:00:00Z" }),
      child({ id: "old-running", status: "running", triggered_at: "2026-05-08T00:00:00Z" }),
      child({ id: "new-running", status: "running", triggered_at: "2026-05-09T00:00:00Z" }),
    ];
    const ordered = sortChildrenForFlyout(list).map((c) => c.id);
    expect(ordered).toEqual([
      "new-running",
      "old-running",
      "new-complete",
      "old-complete",
    ]);
  });

  it("does not mutate the input array", () => {
    const list: ChildWorker[] = [
      child({ id: "a", status: "complete" }),
      child({ id: "b", status: "running" }),
    ];
    const before = [...list];
    sortChildrenForFlyout(list);
    expect(list).toEqual(before);
  });
});

describe("childrenAfterEvent", () => {
  function spawnEvent(payload: unknown, overrides: Partial<SessionEventDTO> = {}): SessionEventDTO {
    return {
      id: overrides.id ?? "ev-1",
      session_id: overrides.session_id ?? SESSION_ID,
      seq: overrides.seq ?? 1,
      type: overrides.type ?? "agent.tool_result",
      payload,
      timestamp: overrides.timestamp ?? "2026-05-09T12:34:56.000Z",
    };
  }

  it("appends a new child for a successful spawn_session tool_result", () => {
    const ev = spawnEvent({
      tool_use_id: "use-1",
      is_error: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            session: {
              id: "ses-child-new",
              agent_id: "agt-worker",
              status: "pending",
              triggered_at: "2026-05-09T12:34:56.000Z",
              parent_session_id: SESSION_ID,
            },
          }),
        },
      ],
    });
    const next = childrenAfterEvent([], ev);
    expect(next).not.toBeNull();
    expect(next!).toHaveLength(1);
    expect(next![0]!.id).toBe("ses-child-new");
    expect(next![0]!.status).toBe("pending");
    expect(next![0]!.agent.id).toBe("agt-worker");
  });

  it("returns null for non tool_result events", () => {
    const ev = spawnEvent({}, { type: "agent.text" });
    expect(childrenAfterEvent([], ev)).toBeNull();
  });

  it("returns null when the tool result reports an error", () => {
    const ev = spawnEvent({
      tool_use_id: "use-1",
      is_error: true,
      content: [{ type: "text", text: JSON.stringify({ session: { id: "x" } }) }],
    });
    expect(childrenAfterEvent([], ev)).toBeNull();
  });

  it("returns null when the result content is not a spawn_session shape", () => {
    const ev = spawnEvent({
      tool_use_id: "use-1",
      content: [{ type: "text", text: '"hello world"' }],
    });
    expect(childrenAfterEvent([], ev)).toBeNull();
  });

  it("ignores duplicates when the child id already exists", () => {
    const existing: ChildRef[] = [child({ id: "ses-dup" })];
    const ev = spawnEvent({
      tool_use_id: "use-1",
      content: [
        {
          type: "text",
          text: JSON.stringify({ session: { id: "ses-dup" } }),
        },
      ],
    });
    expect(childrenAfterEvent(existing, ev)).toBeNull();
  });
});

describe("sessionDetailStore selector stability", () => {
  it("childrenBySession[sessionId] returns the same reference when unchanged", () => {
    const sel = (s: ReturnType<typeof useSessionDetailStore.getState>) =>
      s.childrenBySession[SESSION_ID];
    // Empty case (no slot yet).
    const a = sel(useSessionDetailStore.getState());
    const b = sel(useSessionDetailStore.getState());
    expect(a).toBe(b);
    expect(a).toBeUndefined();

    // Populated case.
    useSessionDetailStore.setState({
      childrenBySession: { [SESSION_ID]: [child()] },
    });
    const c = sel(useSessionDetailStore.getState());
    const d = sel(useSessionDetailStore.getState());
    expect(c).toBe(d);
    expect(c).toHaveLength(1);
  });

  it("appendEvent updates childrenBySession in place when a spawn result lands", () => {
    useSessionDetailStore.setState({
      childrenBySession: { [SESSION_ID]: [] },
    });
    const event: SessionEventDTO = {
      id: "ev-1",
      session_id: SESSION_ID,
      seq: 1,
      type: "agent.tool_result",
      payload: {
        tool_use_id: "use-1",
        is_error: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              session: {
                id: "ses-spawned",
                agent_id: "agt-worker",
                status: "running",
                triggered_at: "2026-05-09T12:34:56.000Z",
              },
            }),
          },
        ],
      },
      timestamp: "2026-05-09T12:34:56.000Z",
    };
    useSessionDetailStore.getState().appendEvent(SESSION_ID, event);
    const list =
      useSessionDetailStore.getState().childrenBySession[SESSION_ID] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("ses-spawned");
  });
});
