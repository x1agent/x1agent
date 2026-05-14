import { describe, expect, test } from "bun:test";
import {
  ALLOWED_SESSION_EVENT_TYPES,
  filterCommentEvent,
  filterSessionEvent,
  scrubSensitiveKeys,
} from "./whitelist";

describe("scrubSensitiveKeys", () => {
  test("redacts top-level credential-looking keys", () => {
    const out = scrubSensitiveKeys({
      api_key: "sk-real-value",
      benign: "ok",
    }) as Record<string, unknown>;
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.benign).toBe("ok");
  });

  test("redacts nested keys", () => {
    const out = scrubSensitiveKeys({
      result: {
        ok: true,
        access_token: "ya29...",
        inner: { client_secret: "abc" },
      },
    }) as { result: { access_token: string; inner: { client_secret: string } } };
    expect(out.result.access_token).toBe("[REDACTED]");
    expect(out.result.inner.client_secret).toBe("[REDACTED]");
  });

  test("matches case-insensitively", () => {
    const out = scrubSensitiveKeys({
      AUTHORIZATION: "Bearer x",
      Password: "p",
    }) as Record<string, unknown>;
    expect(out.AUTHORIZATION).toBe("[REDACTED]");
    expect(out.Password).toBe("[REDACTED]");
  });

  test("redacts inside arrays", () => {
    const out = scrubSensitiveKeys([
      { token: "leak", name: "ok" },
      "plain",
    ]) as Array<Record<string, unknown> | string>;
    expect((out[0] as Record<string, unknown>).token).toBe("[REDACTED]");
    expect((out[0] as Record<string, unknown>).name).toBe("ok");
    expect(out[1]).toBe("plain");
  });

  test("caps recursion depth", () => {
    let deep: Record<string, unknown> = { val: "leaf" };
    for (let i = 0; i < 12; i += 1) {
      deep = { nested: deep };
    }
    const out = scrubSensitiveKeys(deep);
    // Somewhere down the chain we hit the depth cap.
    const json = JSON.stringify(out);
    expect(json.includes("[TRUNCATED]")).toBe(true);
  });

  test("passes through scalars unchanged", () => {
    expect(scrubSensitiveKeys(42)).toBe(42);
    expect(scrubSensitiveKeys("hello")).toBe("hello");
    expect(scrubSensitiveKeys(null)).toBe(null);
    expect(scrubSensitiveKeys(undefined)).toBe(undefined);
  });
});

describe("filterSessionEvent", () => {
  const validBase = {
    session_id: "sess-1",
    sequence: 1,
    type: "agent.text",
    payload: { text: "hi" },
    timestamp: "2026-05-13T22:00:00.000Z",
  };

  test("relays an allowed event", () => {
    const out = filterSessionEvent("sess-1", validBase);
    expect(out).not.toBeNull();
    expect(out!.type).toBe("agent.text");
  });

  test("rejects when session_id mismatches subject", () => {
    const out = filterSessionEvent("sess-1", {
      ...validBase,
      session_id: "sess-2",
    });
    expect(out).toBeNull();
  });

  test("drops unknown event types", () => {
    const out = filterSessionEvent("sess-1", {
      ...validBase,
      type: "agent.internal.secret_leak",
    });
    expect(out).toBeNull();
  });

  test("scrubs payload tokens", () => {
    const out = filterSessionEvent("sess-1", {
      ...validBase,
      payload: { text: "hi", access_token: "ya29" },
    });
    expect(out).not.toBeNull();
    expect((out!.payload as Record<string, unknown>).access_token).toBe(
      "[REDACTED]",
    );
  });

  test("accepts numeric and string sequences", () => {
    const a = filterSessionEvent("sess-1", { ...validBase, sequence: 5 });
    const b = filterSessionEvent("sess-1", { ...validBase, sequence: "7" });
    expect(a?.sequence).toBe(5);
    expect(b?.sequence).toBe(7);
  });

  test("known event-type set covers the browser's renderer", () => {
    // Sanity: the renderer in EventCard handles these prefixes — we
    // assert a few key ones are explicitly in the set.
    const must = [
      "user.message",
      "agent.text",
      "agent.tool_call",
      "session.started",
      "session.completed",
      "session.agent_thinking",
    ];
    for (const t of must) {
      expect(ALLOWED_SESSION_EVENT_TYPES.has(t)).toBe(true);
    }
  });
});

describe("filterCommentEvent", () => {
  const valid = {
    share_id: "share-1",
    thread_id: "thread-1",
    comment_id: "comment-1",
    actor_user_id: "user-1",
    actor_session_id: "session-1",
    comment_scope: "share",
    anchor: null,
    comment_body: "looks good",
    workspace_id: "ws-1",
    session_id: "sess-1",
    share_type: "site",
    parent_comment_id: null,
    producing_session_id: "secret-producer",
    producing_agent_id: "secret-agent",
  };

  test("relays the browser-facing fields", () => {
    const out = filterCommentEvent(valid);
    expect(out).not.toBeNull();
    expect(out!.comment_body).toBe("looks good");
    expect(out!.workspace_id).toBe("ws-1");
  });

  test("drops internal routing fields", () => {
    const out = filterCommentEvent(valid) as unknown as Record<string, unknown>;
    expect("producing_session_id" in out).toBe(false);
    expect("producing_agent_id" in out).toBe(false);
  });

  test("rejects when an id is missing", () => {
    const out = filterCommentEvent({ ...valid, share_id: undefined });
    expect(out).toBeNull();
  });

  test("scrubs sensitive keys inside anchor blob", () => {
    const out = filterCommentEvent({
      ...valid,
      anchor: { snippet: "ok", api_key: "secret" },
    });
    expect((out!.anchor as Record<string, unknown>).api_key).toBe(
      "[REDACTED]",
    );
  });
});
