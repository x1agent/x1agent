import { describe, it, expect } from "bun:test";
import {
  normalizeCodexEvent,
  normalizeCodexNotification,
  type NormalizedEvent,
} from "./normalize.js";

function asArray(
  e: NormalizedEvent | NormalizedEvent[] | null,
): NormalizedEvent[] {
  if (e === null) return [];
  return Array.isArray(e) ? e : [e];
}

describe("normalizeCodexEvent", () => {
  it("returns null for unknown / falsy inputs", () => {
    expect(normalizeCodexEvent(null)).toBeNull();
    expect(normalizeCodexEvent(undefined)).toBeNull();
    expect(normalizeCodexEvent({ type: "nonsense" })).toBeNull();
  });

  it("emits session.init for thread.started", () => {
    const out = normalizeCodexEvent({ type: "thread.started" });
    expect(out).toBeTruthy();
    if (out && !Array.isArray(out)) {
      expect(out.type).toBe("session.init");
      expect((out.payload as { mcp_servers: unknown[] }).mcp_servers).toEqual(
        [],
      );
    }
  });

  it("drops turn.started and item.started/updated", () => {
    expect(normalizeCodexEvent({ type: "turn.started" })).toBeNull();
    expect(
      normalizeCodexEvent({
        type: "item.started",
        item: { type: "agent_message" },
      }),
    ).toBeNull();
    expect(
      normalizeCodexEvent({
        type: "item.updated",
        item: { type: "agent_message", text: "partial" },
      }),
    ).toBeNull();
  });

  it("maps agent_message → agent.text", () => {
    const out = normalizeCodexEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "hello world" },
    });
    expect(out).toBeTruthy();
    if (out && !Array.isArray(out)) {
      expect(out.type).toBe("agent.text");
      expect((out.payload as { text: string }).text).toBe("hello world");
    }
  });

  it("maps reasoning → agent.thinking", () => {
    const out = normalizeCodexEvent({
      type: "item.completed",
      item: { id: "i2", type: "reasoning", text: "thinking…" },
    });
    expect(out).toBeTruthy();
    if (out && !Array.isArray(out)) {
      expect(out.type).toBe("agent.thinking");
    }
  });

  it("maps command_execution → tool_call + tool_result with bash tool name", () => {
    const events = asArray(
      normalizeCodexEvent({
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls /workspace",
          output: "README.md\nsrc",
          exit_code: 0,
        },
      }),
    );
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("agent.tool_call");
    expect((events[0]!.payload as { tool_name: string }).tool_name).toBe(
      "bash",
    );
    expect(events[1]!.type).toBe("agent.tool_result");
    expect((events[1]!.payload as { is_error: boolean }).is_error).toBe(false);
  });

  it("flags non-zero exit_code on command_execution as is_error", () => {
    const events = asArray(
      normalizeCodexEvent({
        type: "item.completed",
        item: {
          id: "cmd-2",
          type: "command_execution",
          command: "false",
          output: "",
          exit_code: 1,
        },
      }),
    );
    expect((events[1]!.payload as { is_error: boolean }).is_error).toBe(true);
  });

  it("maps mcp_tool_call → tool_call + tool_result passing tool name through", () => {
    const events = asArray(
      normalizeCodexEvent({
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          tool: "mcp__x1agent__emit_status",
          arguments: { status: "starting" },
          result: { ok: true },
        },
      }),
    );
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("agent.tool_call");
    expect((events[0]!.payload as { tool_name: string }).tool_name).toBe(
      "mcp__x1agent__emit_status",
    );
    expect(events[1]!.type).toBe("agent.tool_result");
  });

  it("logs turn.completed usage without emitting an event in v0", () => {
    const logged: string[] = [];
    const out = normalizeCodexEvent(
      {
        type: "turn.completed",
        model: "gpt-5.3-codex",
        usage: { input_tokens: 1234, output_tokens: 567 },
      },
      { logUsage: (m) => logged.push(m) },
    );
    expect(out).toBeNull();
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("input=1234");
    expect(logged[0]).toContain("output=567");
    expect(logged[0]).toContain("gpt-5.3-codex");
  });

  it("maps turn.failed and top-level error to agent.error", () => {
    const failed = normalizeCodexEvent({
      type: "turn.failed",
      message: "model timeout",
    });
    expect(failed).toBeTruthy();
    if (failed && !Array.isArray(failed)) {
      expect(failed.type).toBe("agent.error");
      expect((failed.payload as { message: string }).message).toBe(
        "model timeout",
      );
    }

    const errored = normalizeCodexEvent({
      type: "error",
      error: "auth failed",
    });
    if (errored && !Array.isArray(errored)) {
      expect(errored.type).toBe("agent.error");
    }
  });

  it("surfaces nested app-server error messages", () => {
    const out = normalizeCodexEvent({
      method: "error",
      params: {
        error: {
          message: JSON.stringify({
            error: {
              message: "The selected model is not supported for this login.",
            },
          }),
        },
      },
    });
    expect(out).toEqual({
      type: "agent.error",
      payload: {
        message: "The selected model is not supported for this login.",
        recoverable: false,
      },
    });
  });

  it("maps turn/failed notifications and nested turn errors", () => {
    const out = normalizeCodexNotification("turn/failed", {
      turn: { error: { message: "turn failed for a concrete reason" } },
    });
    expect(out).toEqual({
      type: "agent.error",
      payload: {
        message: "turn failed for a concrete reason",
        recoverable: false,
      },
    });
  });

  it("surfaces an error nested in turn/completed", () => {
    const out = normalizeCodexNotification("turn/completed", {
      turn: { status: "failed", error: { message: "turn completion failed" } },
    });
    expect(out).toEqual({
      type: "agent.error",
      payload: { message: "turn completion failed", recoverable: false },
    });
  });

  it("unwraps msg-envelope shape (App Server SDK style)", () => {
    const out = normalizeCodexEvent({
      msg: {
        type: "item.completed",
        item: { id: "x", type: "agent_message", text: "hi" },
      },
    });
    if (out && !Array.isArray(out)) {
      expect(out.type).toBe("agent.text");
    }
  });

  it("end-to-end: a hello-world Codex JSONL fixture produces the expected event sequence", () => {
    // Captured shape of `codex exec --json "say hello"` output, edited for
    // brevity. Asserts the §2 mapping table at the level downstream
    // subscribers see — one session.init, one agent.text, one
    // agent.tool_call from an MCP invocation.
    const fixture: unknown[] = [
      { type: "thread.started", thread_id: "thr_123" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          tool: "mcp__x1agent__emit_status",
          arguments: { status: "starting", detail: "greeting the world" },
          result: { ok: true },
        },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Hello, world!" },
      },
      {
        type: "turn.completed",
        model: "gpt-5.3-codex",
        usage: { input_tokens: 42, output_tokens: 7 },
      },
    ];

    const emitted: NormalizedEvent[] = [];
    for (const raw of fixture) {
      for (const e of asArray(normalizeCodexEvent(raw))) emitted.push(e);
    }

    const types = emitted.map((e) => e.type);
    expect(types).toContain("session.init");
    expect(types).toContain("agent.text");
    expect(types).toContain("agent.tool_call");
    expect(types).toContain("agent.tool_result");
    // The tool_call carries the MCP tool name verbatim — that's what the
    // brief's acceptance criterion ("one agent.tool_call event from
    // invoking emit_status via the x1agent MCP") is asserting.
    const toolCall = emitted.find((e) => e.type === "agent.tool_call");
    expect(
      (toolCall?.payload as { tool_name: string } | undefined)?.tool_name,
    ).toBe("mcp__x1agent__emit_status");
  });
});

describe("normalizeCodexNotification (Codex app-server v2)", () => {
  it("maps streamed assistant deltas without waiting for item completion", () => {
    expect(
      normalizeCodexNotification("item/agentMessage/delta", { delta: "hello" }),
    ).toEqual({ type: "agent.text", payload: { text: "hello" } });
  });

  it("maps current camelCase command and MCP items", () => {
    const command = normalizeCodexNotification("item/completed", {
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "pwd",
        aggregatedOutput: "/workspace",
        exitCode: 0,
        status: "completed",
      },
    });
    expect(asArray(command).map((event) => event.type)).toEqual([
      "agent.tool_call",
      "agent.tool_result",
    ]);

    const mcp = normalizeCodexNotification("item/completed", {
      item: {
        type: "mcpToolCall",
        id: "mcp-1",
        tool: "emit_status",
        arguments: { status: "working" },
        result: { ok: true },
        status: "completed",
      },
    });
    expect((asArray(mcp)[0]!.payload as { tool_name: string }).tool_name).toBe(
      "emit_status",
    );
  });
});
