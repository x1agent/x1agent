import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");

describe("Claude skill settings boundary", () => {
  test("enables all user-installed skills without trusting project settings", () => {
    expect(source).toContain('settingSources: ["user"]');
    expect(source).toContain('skills: "all"');
    expect(source).not.toContain('settingSources: ["user", "project"]');
  });
});
