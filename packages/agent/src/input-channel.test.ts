import { describe, it, expect } from "bun:test";
import { createInputChannel } from "./input-channel.js";

describe("createInputChannel", () => {
  it("delivers a queued message to the first next()", async () => {
    const ch = createInputChannel();
    ch.push("hello");
    const it = ch[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.done).toBe(false);
    expect(r.value.message.content).toBe("hello");
    expect(r.value.type).toBe("user");
  });

  it("next() blocks until push() resolves it", async () => {
    const ch = createInputChannel();
    const it = ch[Symbol.asyncIterator]();
    const pending = it.next();
    ch.push("later");
    const r = await pending;
    expect(r.value.message.content).toBe("later");
  });

  it("preserves parent_tool_use_id when provided", async () => {
    const ch = createInputChannel();
    ch.push("answer", "req-42");
    const it = ch[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.value.parent_tool_use_id).toBe("req-42");
  });

  it("sets parent_tool_use_id to null by default", async () => {
    const ch = createInputChannel();
    ch.push("plain");
    const it = ch[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.value.parent_tool_use_id).toBeNull();
  });

  it("pending reflects queue depth", () => {
    const ch = createInputChannel();
    expect(ch.pending).toBe(0);
    ch.push("a");
    ch.push("b");
    expect(ch.pending).toBe(2);
  });
});
