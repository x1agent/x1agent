import { describe, expect, test } from "bun:test";
import { parseAgentSkillSources } from "./skill-source.js";

describe("parseAgentSkillSources", () => {
  test("normalizes a public GitHub skill reference", () => {
    expect(
      parseAgentSkillSources([
        {
          repository: "https://github.com/acme/agent-plugin/",
          ref: "v1.2.0",
          path: "./skills/review/",
        },
      ]),
    ).toEqual([
      {
        repository: "https://github.com/acme/agent-plugin",
        ref: "v1.2.0",
        path: "skills/review",
      },
    ]);
  });

  test("allows an empty ref and path", () => {
    expect(
      parseAgentSkillSources([
        { repository: "https://github.com/openai/skills" },
      ]),
    ).toEqual([
      { repository: "https://github.com/openai/skills", ref: "", path: "" },
    ]);
  });

  test.each([
    "http://github.com/acme/skills",
    "https://gitlab.com/acme/skills",
    "https://token@github.com/acme/skills",
    "https://github.com/acme/skills/tree/main",
  ])("rejects unsafe repository URL %s", (repository) => {
    expect(() => parseAgentSkillSources([{ repository }])).toThrow();
  });

  test("rejects traversal in refs and paths", () => {
    expect(() =>
      parseAgentSkillSources([
        { repository: "https://github.com/acme/skills", ref: "../secret" },
      ]),
    ).toThrow();
    expect(() =>
      parseAgentSkillSources([
        { repository: "https://github.com/acme/skills", path: "../secret" },
      ]),
    ).toThrow();
  });
});
