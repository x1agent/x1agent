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

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID_A = "22222222-2222-4222-8222-222222222222";
const CHILD_ID_B = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const FOREIGN_PARENT_ID = "99999999-9999-4999-8999-999999999999";

function child(overrides: Partial<ChildWorker> = {}): ChildWorker {
  return {
    id: overrides.id ?? CHILD_ID_A,
    status: overrides.status ?? "running",
    triggered_at: overrides.triggered_at ?? "2026-05-09T12:00:00.000Z",
    agent: overrides.agent ?? {
      id: AGENT_ID,
      slug: "worker-bot",
      name: "Worker Bot",
    },
  };
}

function spawnEvent(
  payload: unknown,
  overrides: Partial<SessionEventDTO> = {},
): SessionEventDTO {
  return {
    id: overrides.id ?? "ev-1",
    session_id: overrides.session_id ?? PARENT_ID,
    seq: overrides.seq ?? 1,
    type: overrides.type ?? "agent.tool_result",
    payload,
    timestamp: overrides.timestamp ?? "2026-05-09T12:34:56.000Z",
  };
}

function spawnPayload(session: Record<string, unknown>, isError = false) {
  return {
    tool_use_id: "use-1",
    is_error: isError,
    content: [{ type: "text", text: JSON.stringify({ session }) }],
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
      child({ id: "id-a", status: "running" }),
      child({ id: "id-b", status: "pending" }),
      child({ id: "id-c", status: "complete" }),
      child({ id: "id-d", status: "failed" }),
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
      child({ id: "id-old-c", status: "complete", triggered_at: "2026-05-08T00:00:00Z" }),
      child({ id: "id-new-c", status: "complete", triggered_at: "2026-05-09T00:00:00Z" }),
      child({ id: "id-old-r", status: "running", triggered_at: "2026-05-08T00:00:00Z" }),
      child({ id: "id-new-r", status: "running", triggered_at: "2026-05-09T00:00:00Z" }),
    ];
    const ordered = sortChildrenForFlyout(list).map((c) => c.id);
    expect(ordered).toEqual(["id-new-r", "id-old-r", "id-new-c", "id-old-c"]);
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
  it("appends a new child for a successful spawn_session tool_result", () => {
    const ev = spawnEvent(
      spawnPayload({
        id: CHILD_ID_A,
        agent_id: AGENT_ID,
        status: "pending",
        triggered_at: "2026-05-09T12:34:56.000Z",
        parent_session_id: PARENT_ID,
      }),
    );
    const next = childrenAfterEvent([], ev, PARENT_ID);
    expect(next).not.toBeNull();
    expect(next!).toHaveLength(1);
    expect(next![0]!.id).toBe(CHILD_ID_A);
    expect(next![0]!.status).toBe("pending");
    expect(next![0]!.agent.id).toBe(AGENT_ID);
  });

  it("returns null for non tool_result events", () => {
    const ev = spawnEvent({}, { type: "agent.text" });
    expect(childrenAfterEvent([], ev, PARENT_ID)).toBeNull();
  });

  it("returns null when the tool result reports an error", () => {
    const ev = spawnEvent(
      spawnPayload(
        {
          id: CHILD_ID_A,
          agent_id: AGENT_ID,
          status: "pending",
          parent_session_id: PARENT_ID,
        },
        true,
      ),
    );
    expect(childrenAfterEvent([], ev, PARENT_ID)).toBeNull();
  });

  it("returns null when the parsed parent_session_id targets a different session", () => {
    const ev = spawnEvent(
      spawnPayload({
        id: CHILD_ID_A,
        agent_id: AGENT_ID,
        status: "pending",
        parent_session_id: FOREIGN_PARENT_ID,
      }),
    );
    expect(childrenAfterEvent([], ev, PARENT_ID)).toBeNull();
  });

  it("rejects non-UUID ids — defence against path-traversal payloads", () => {
    const ev = spawnEvent(
      spawnPayload({
        id: "../../other-slug/sessions/abc",
        agent_id: AGENT_ID,
        status: "pending",
        parent_session_id: PARENT_ID,
      }),
    );
    expect(childrenAfterEvent([], ev, PARENT_ID)).toBeNull();
  });

  it("returns null when the result content is not a spawn_session shape", () => {
    const ev = spawnEvent({
      tool_use_id: "use-1",
      content: [{ type: "text", text: '"hello world"' }],
    });
    expect(childrenAfterEvent([], ev, PARENT_ID)).toBeNull();
  });

  it("skips invalid content blocks and parses the next valid one", () => {
    const ev = spawnEvent({
      tool_use_id: "use-1",
      is_error: false,
      content: [
        { type: "image", text: "no good" },
        { type: "text", text: "{{ not json" },
        {
          type: "text",
          text: JSON.stringify({
            session: {
              id: CHILD_ID_A,
              agent_id: AGENT_ID,
              status: "running",
              triggered_at: "2026-05-09T12:34:56.000Z",
              parent_session_id: PARENT_ID,
            },
          }),
        },
      ],
    });
    const next = childrenAfterEvent([], ev, PARENT_ID);
    expect(next).not.toBeNull();
    expect(next![0]!.id).toBe(CHILD_ID_A);
  });

  it("upserts an existing child and updates its status", () => {
    const existing: ChildRef[] = [
      child({
        id: CHILD_ID_A,
        status: "pending",
        agent: { id: AGENT_ID, slug: "worker-bot", name: "Worker Bot" },
      }),
    ];
    const ev = spawnEvent(
      spawnPayload({
        id: CHILD_ID_A,
        agent_id: AGENT_ID,
        status: "running",
        triggered_at: "2026-05-09T12:34:56.000Z",
        parent_session_id: PARENT_ID,
      }),
    );
    const next = childrenAfterEvent(existing, ev, PARENT_ID);
    expect(next).not.toBeNull();
    expect(next!).toHaveLength(1);
    expect(next![0]!.status).toBe("running");
    // The previously-resolved agent name beats the parser's
    // placeholder so the flyout doesn't degrade after a status update.
    expect(next![0]!.agent.name).toBe("Worker Bot");
  });

  it("returns null when the upsert would be a true no-op", () => {
    const existing: ChildRef[] = [
      child({
        id: CHILD_ID_A,
        status: "pending",
        triggered_at: "2026-05-09T12:34:56.000Z",
        agent: {
          id: AGENT_ID,
          // Existing record is itself a placeholder, so the parser's
          // placeholder is the same agent ref. With status and
          // triggered_at also matching, this is a referentially
          // identical update and we keep selectors stable.
          slug: AGENT_ID,
          name: "Child session",
        },
      }),
    ];
    const ev = spawnEvent(
      spawnPayload({
        id: CHILD_ID_A,
        agent_id: AGENT_ID,
        status: "pending",
        triggered_at: "2026-05-09T12:34:56.000Z",
        parent_session_id: PARENT_ID,
      }),
    );
    expect(childrenAfterEvent(existing, ev, PARENT_ID)).toBeNull();
  });
});

describe("sessionDetailStore selector stability", () => {
  it("childrenBySession[sessionId] returns the same reference when unchanged", () => {
    const sel = (s: ReturnType<typeof useSessionDetailStore.getState>) =>
      s.childrenBySession[PARENT_ID];
    // Empty case (no slot yet).
    const a = sel(useSessionDetailStore.getState());
    const b = sel(useSessionDetailStore.getState());
    expect(a).toBe(b);
    expect(a).toBeUndefined();

    // Populated case.
    useSessionDetailStore.setState({
      childrenBySession: { [PARENT_ID]: [child()] },
    });
    const c = sel(useSessionDetailStore.getState());
    const d = sel(useSessionDetailStore.getState());
    expect(c).toBe(d);
    expect(c).toHaveLength(1);
  });

  it("appendEvent updates childrenBySession in place when a spawn result lands", () => {
    useSessionDetailStore.setState({
      childrenBySession: { [PARENT_ID]: [] },
    });
    const event: SessionEventDTO = spawnEvent(
      spawnPayload({
        id: CHILD_ID_B,
        agent_id: AGENT_ID,
        status: "running",
        triggered_at: "2026-05-09T12:34:56.000Z",
        parent_session_id: PARENT_ID,
      }),
    );
    useSessionDetailStore.getState().appendEvent(PARENT_ID, event);
    const list =
      useSessionDetailStore.getState().childrenBySession[PARENT_ID] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(CHILD_ID_B);
  });

  it("appendEvent advances a child's status on a follow-up spawn result", () => {
    const seeded = child({
      id: CHILD_ID_A,
      status: "pending",
      agent: { id: AGENT_ID, slug: "worker-bot", name: "Worker Bot" },
    });
    useSessionDetailStore.setState({
      childrenBySession: { [PARENT_ID]: [seeded] },
    });
    const followup: SessionEventDTO = spawnEvent(
      spawnPayload({
        id: CHILD_ID_A,
        agent_id: AGENT_ID,
        status: "running",
        triggered_at: "2026-05-09T12:35:00.000Z",
        parent_session_id: PARENT_ID,
      }),
      { seq: 5 },
    );
    useSessionDetailStore.getState().appendEvent(PARENT_ID, followup);
    const list =
      useSessionDetailStore.getState().childrenBySession[PARENT_ID] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("running");
    expect(list[0]!.agent.name).toBe("Worker Bot");
  });
});
