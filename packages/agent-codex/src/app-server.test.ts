import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildTurnInputs, CodexAppServer } from "./app-server.js";

describe("Codex app-server turn inputs", () => {
  it("adds resolved uploads as native localImage inputs", () => {
    expect(
      buildTurnInputs("inspect this", ["/workspace/.x1/uploads/a.png"]),
    ).toEqual([
      { type: "text", text: "inspect this", text_elements: [] },
      { type: "localImage", path: "/workspace/.x1/uploads/a.png" },
    ]);
  });
});

describe("Codex app-server lifecycle", () => {
  it("keeps a turn pending until turn/completed and rejects overlap", async () => {
    const server = new CodexAppServer({
      binary: fileURLToPath(
        new URL("./test-fixtures/fake-app-server.mjs", import.meta.url),
      ),
      cwd: process.cwd(),
      sandbox: "danger-full-access",
      onEvent: () => {},
    });
    const threadId = await server.start();
    let completed = false;
    const first = server.turn(threadId, "first").then(() => {
      completed = true;
    });
    await Bun.sleep(10);
    expect(completed).toBe(false);
    expect(server.turn(threadId, "overlap")).rejects.toThrow(
      "already in flight",
    );
    await first;
    expect(completed).toBe(true);
    server.stop();
  });

  it("times out a JSON-RPC request instead of hanging forever", async () => {
    const server = new CodexAppServer({
      binary: fileURLToPath(
        new URL("./test-fixtures/silent-app-server.mjs", import.meta.url),
      ),
      cwd: process.cwd(),
      sandbox: "danger-full-access",
      requestTimeoutMs: 20,
      onEvent: () => {},
    });
    expect(server.start()).rejects.toThrow("initialize timed out");
    server.stop();
  });
});
