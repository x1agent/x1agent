import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverSkillDirectories,
  installSkillSources,
  parseSkillSourcesJson,
} from "./install-skills.js";

const temporary: string[] = [];
function tempDir() {
  const value = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
  temporary.push(value);
  return value;
}
afterEach(() => {
  for (const value of temporary.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("skill installation", () => {
  test("discovers standalone and plugin skill layouts", () => {
    const standalone = tempDir();
    writeFileSync(path.join(standalone, "SKILL.md"), "---\nname: one\n---\n");
    expect(discoverSkillDirectories(standalone)).toEqual([standalone]);
    const plugin = tempDir();
    mkdirSync(path.join(plugin, "skills", "two"), { recursive: true });
    writeFileSync(path.join(plugin, "skills", "two", "SKILL.md"), "two");
    expect(discoverSkillDirectories(plugin)).toEqual([
      path.join(plugin, "skills", "two"),
    ]);
  });

  test("projects a fetched plugin into both harness discovery paths", async () => {
    const fixture = tempDir();
    mkdirSync(path.join(fixture, "skills", "review"), { recursive: true });
    writeFileSync(path.join(fixture, "skills", "review", "SKILL.md"), "review");
    const home = tempDir();
    const exec = async (_command: string, args: string[]) => {
      const destination = args.at(-1)!;
      mkdirSync(destination, { recursive: true });
      cpSync(fixture, destination, { recursive: true });
    };
    await expect(
      installSkillSources([{ repository: "https://github.com/acme/review" }], {
        homeDir: home,
        exec,
      }),
    ).resolves.toEqual(["review"]);
    expect(
      existsSync(path.join(home, ".claude", "skills", "review", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(path.join(home, ".agents", "skills", "review", "SKILL.md")),
    ).toBe(true);
  });

  test("rejects malformed environment JSON", () => {
    expect(() => parseSkillSourcesJson("{}")).toThrow(
      "AGENT_SKILL_SOURCES_JSON must be an array",
    );
  });
});
