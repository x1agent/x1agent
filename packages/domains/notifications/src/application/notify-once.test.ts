import { describe, it, expect } from "bun:test";
import { UserId, WorkspaceId } from "@x1agent/kernel";
import { notifyOnce } from "./notify-once.js";
import { InMemoryNotificationRepository } from "./fakes.js";

const WORKSPACE_A = WorkspaceId("11111111-1111-1111-1111-111111111111");
const USER_ALICE = UserId("22222222-2222-2222-2222-222222222222");
const USER_BOB = UserId("33333333-3333-3333-3333-333333333333");

describe("notifyOnce", () => {
  it("writes a notification for a distinct recipient", async () => {
    const repo = new InMemoryNotificationRepository();
    const result = await notifyOnce(
      { repository: repo },
      {
        recipientUserId: USER_BOB,
        actorUserId: USER_ALICE,
        workspaceId: WORKSPACE_A,
        kind: "comment_mention",
        sourceEventId: "evt-1",
        payload: { snippet: "hello @bob" },
      },
    );

    expect(result.kind).toBe("written");
    if (result.kind === "written") {
      expect(result.notification.userId).toBe(USER_BOB);
      expect(result.notification.kind).toBe("comment_mention");
      expect(result.notification.readAt).toBeNull();
    }
    expect(repo.all()).toHaveLength(1);
  });

  it("skips self-notify when actor === recipient", async () => {
    const repo = new InMemoryNotificationRepository();
    const result = await notifyOnce(
      { repository: repo },
      {
        recipientUserId: USER_ALICE,
        actorUserId: USER_ALICE,
        workspaceId: WORKSPACE_A,
        kind: "comment_mention",
        sourceEventId: "evt-self",
        payload: {},
      },
    );

    expect(result.kind).toBe("self_skipped");
    expect(repo.all()).toHaveLength(0);
  });

  it("does NOT apply self-skip when actor is null (agent actor)", async () => {
    const repo = new InMemoryNotificationRepository();
    const result = await notifyOnce(
      { repository: repo },
      {
        recipientUserId: USER_ALICE,
        actorUserId: null,
        workspaceId: WORKSPACE_A,
        kind: "comment_mention",
        sourceEventId: "evt-agent",
        payload: {},
      },
    );

    expect(result.kind).toBe("written");
    expect(repo.all()).toHaveLength(1);
  });

  it("re-firing the same source event for the same recipient is a duplicate, not a throw", async () => {
    const repo = new InMemoryNotificationRepository();
    const first = await notifyOnce(
      { repository: repo },
      {
        recipientUserId: USER_BOB,
        actorUserId: USER_ALICE,
        workspaceId: WORKSPACE_A,
        kind: "comment_mention",
        sourceEventId: "evt-replay",
        payload: { snippet: "hi" },
      },
    );
    const second = await notifyOnce(
      { repository: repo },
      {
        recipientUserId: USER_BOB,
        actorUserId: USER_ALICE,
        workspaceId: WORKSPACE_A,
        kind: "comment_mention",
        sourceEventId: "evt-replay",
        payload: { snippet: "hi" },
      },
    );

    expect(first.kind).toBe("written");
    expect(second.kind).toBe("duplicate");
    expect(repo.all()).toHaveLength(1);
  });

  it("same source event for two different recipients writes two rows", async () => {
    const repo = new InMemoryNotificationRepository();
    // A mention writer might fan one event to multiple users — each
    // pair (user, source_event_id) is independently idempotent.
    await notifyOnce(
      { repository: repo },
      {
        recipientUserId: USER_BOB,
        actorUserId: USER_ALICE,
        workspaceId: WORKSPACE_A,
        kind: "comment_mention",
        sourceEventId: "evt-fanout",
        payload: {},
      },
    );
    await notifyOnce(
      { repository: repo },
      {
        recipientUserId: USER_ALICE,
        actorUserId: null, // agent author
        workspaceId: WORKSPACE_A,
        kind: "comment_mention",
        sourceEventId: "evt-fanout",
        payload: {},
      },
    );

    expect(repo.all()).toHaveLength(2);
  });
});
