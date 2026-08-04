import { describe, expect, it } from "bun:test";
import type { RuntimeModelDTO } from "@x1agent/shared";
import { pickPreferredRuntimeModel } from "./runtime-model-default";

const models = (...entries: Array<[string, string]>): RuntimeModelDTO[] =>
  entries.map(([id, label]) => ({
    runtime_type: "codex",
    id,
    label,
    input_usd_per_million: null,
    output_usd_per_million: null,
    source: "harness",
  }));

describe("pickPreferredRuntimeModel", () => {
  it("selects the Claude Sonnet id case-insensitively", () => {
    expect(
      pickPreferredRuntimeModel(
        "claude_code",
        models(["HAIKU", "Haiku"], ["SoNnEt", "Claude Sonnet"]),
      ),
    ).toBe("SoNnEt");
  });

  it("selects the exact Codex Terra model returned by the harness", () => {
    expect(
      pickPreferredRuntimeModel(
        "codex",
        models(
          ["gpt-5.6-sol", "GPT-5.6-Sol"],
          ["gpt-5.6-terra", "GPT-5.6-Terra"],
        ),
      ),
    ).toBe("gpt-5.6-terra");
  });

  it("falls back to the reported harness default without guessing", () => {
    expect(
      pickPreferredRuntimeModel(
        "codex",
        models(["future-default", "Future Default"]),
        "future-default",
      ),
    ).toBe("future-default");
  });
});
