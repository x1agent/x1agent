import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Mirror of packages/agent/src/x1-mcp-description.test.ts for the
 * Codex runtime. Both agent runtimes serve the same MCP tool list;
 * any divergence in scope wording would mean a different runtime
 * gets a different agent-level "I can't" verdict.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "./x1-mcp.ts"), "utf8");

describe("read_share MCP tool description (codex runtime)", () => {
  it("declares the workspace-wide scope (no Slice A wording)", () => {
    expect(source).toContain("anywhere in this workspace");
    expect(source).toContain("ANY session in this workspace");
  });

  it("does not retain the stale single-session scope wording", () => {
    expect(source).not.toContain("Slice A (PRD 0006) scope");
    expect(source).not.toContain("200 only when the share belongs to THIS session");
    expect(source).not.toContain(
      "Slice A only allows reading shares this session produced",
    );
  });

  it("tells the agent how to update an existing share by id", () => {
    expect(source).toMatch(/To UPDATE a share/);
    expect(source).toMatch(/SAME `share_id`/);
  });

  it("names the new cross-workspace 403 error code", () => {
    expect(source).toContain("cross_workspace_read_forbidden");
  });
});
