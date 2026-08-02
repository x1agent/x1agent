import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Pins the read_share + share MCP tool descriptions the agent sees in
 * its tool list. The descriptions are the agent's source of truth for
 * scope semantics — if they say "Slice A: only THIS session", Claude
 * looks at its toolbox, agrees, and refuses to even attempt a
 * cross-session read. That made the server-side workspace-scope fix
 * functionally invisible on x1agent.com until the descriptions also
 * matched.
 *
 * Both Claude and Codex load this single shared implementation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "./x1-mcp.ts"), "utf8");

describe("read_share MCP tool description (agent runtime)", () => {
  it("declares the workspace-wide scope (no Slice A wording)", () => {
    expect(source).toContain("anywhere in this workspace");
    expect(source).toContain("ANY session in this workspace");
  });

  it("does not retain the stale single-session scope wording", () => {
    expect(source).not.toContain("Slice A (PRD 0006) scope");
    expect(source).not.toContain(
      "200 only when the share belongs to THIS session",
    );
    expect(source).not.toContain(
      "Slice A only allows reading shares this session produced",
    );
  });

  it("tells the agent how to update an existing share by id", () => {
    expect(source).toMatch(/To UPDATE a share/);
    expect(source).toMatch(/SAME `share_id`/);
  });

  it("names the new cross-workspace 403 error code so the agent can branch on it", () => {
    expect(source).toContain("cross_workspace_read_forbidden");
  });
});
