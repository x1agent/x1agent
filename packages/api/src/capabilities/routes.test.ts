import { describe, expect, it } from "bun:test";
import { applyEnabledModelPolicy } from "./routes";

const catalog = [{ id: "default" }, { id: "sonnet" }, { id: "haiku" }];

describe("applyEnabledModelPolicy", () => {
  it("keeps the harness catalog available before curation", () => {
    expect(applyEnabledModelPolicy(catalog, new Set())).toEqual(catalog);
  });

  it("applies the allowlist once at least one model is enabled", () => {
    expect(applyEnabledModelPolicy(catalog, new Set(["sonnet"]))).toEqual([
      { id: "sonnet" },
    ]);
  });
});
