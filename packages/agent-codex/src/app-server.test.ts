import { describe, expect, it } from "bun:test";
import { buildTurnInputs } from "./app-server.js";

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
