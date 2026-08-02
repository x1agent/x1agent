import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const providerFiles = [
  "files-mcp.ts",
  "sheets-mcp.ts",
  "docs-mcp.ts",
  "calendar-mcp.ts",
  "email-mcp.ts",
];

describe("Claude/Codex provider MCP parity", () => {
  for (const file of providerFiles) {
    it(`${file} stays identical to the Claude runtime implementation`, async () => {
      const codex = await readFile(path.resolve(import.meta.dir, file), "utf8");
      const claude = await readFile(
        path.resolve(import.meta.dir, "../../agent/src", file),
        "utf8",
      );
      expect(codex).toBe(claude);
    });
  }
});
