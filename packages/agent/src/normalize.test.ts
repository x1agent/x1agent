import { describe, it, expect } from "bun:test";
import { normalizeMessage } from "./normalize.js";

describe("normalizeMessage", () => {
  it("returns null for unknown message types", () => {
    expect(normalizeMessage({ type: "unknown" })).toBeNull();
    expect(normalizeMessage(null)).toBeNull();
    expect(normalizeMessage(undefined)).toBeNull();
  });

  it("emits session.init for system/init", () => {
    const ev = normalizeMessage({
      type: "system",
      subtype: "init",
      mcp_servers: ["x1agent"],
      tools: ["mcp__x1agent__emit_status"],
    });
    expect(ev).toBeTruthy();
    expect(Array.isArray(ev)).toBe(false);
    if (ev && !Array.isArray(ev)) {
      expect(ev.type).toBe("session.init");
      expect((ev.payload as { mcp_servers: unknown[] }).mcp_servers).toEqual([
        "x1agent",
      ]);
    }
  });

  it("ignores non-init system messages", () => {
    expect(normalizeMessage({ type: "system", subtype: "other" })).toBeNull();
  });

  it("splits assistant message with text + tool_use into multiple events", () => {
    const events = normalizeMessage({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    });
    expect(Array.isArray(events)).toBe(true);
    if (Array.isArray(events)) {
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("agent.text");
      expect(events[1]!.type).toBe("agent.tool_call");
    }
  });

  it("single-block assistant messages return a single event", () => {
    const ev = normalizeMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(Array.isArray(ev)).toBe(false);
    if (ev && !Array.isArray(ev)) {
      expect(ev.type).toBe("agent.text");
    }
  });

  it("emits agent.thinking", () => {
    const ev = normalizeMessage({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "let me see" }] },
    });
    expect(Array.isArray(ev)).toBe(false);
    if (ev && !Array.isArray(ev)) {
      expect(ev.type).toBe("agent.thinking");
      expect((ev.payload as { text: string }).text).toBe("let me see");
    }
  });

  it("maps is_error tool_result to agent.tool_error", () => {
    const ev = normalizeMessage({
      type: "tool_result",
      tool_use_id: "t1",
      content: "bad",
      is_error: true,
    });
    if (ev && !Array.isArray(ev)) expect(ev.type).toBe("agent.tool_error");
  });

  it("maps non-error tool_result to agent.tool_result", () => {
    const ev = normalizeMessage({
      type: "tool_result",
      tool_use_id: "t1",
      content: "good",
    });
    if (ev && !Array.isArray(ev)) expect(ev.type).toBe("agent.tool_result");
  });

  it("returns null for assistant messages with no recognised blocks", () => {
    expect(
      normalizeMessage({
        type: "assistant",
        message: { content: [{ type: "image" }] },
      }),
    ).toBeNull();
  });
});
