import { describe, it, expect } from "bun:test";
import { WorkspaceSlug, slugify } from "./slug.js";
import { ValidationError } from "./errors.js";

describe("WorkspaceSlug", () => {
  it.each([
    ["default", "default"],
    ["my-team", "my-team"],
    ["  TeamX  ", "teamx"],
    ["a1-b2-c3", "a1-b2-c3"],
  ])("accepts %p and normalizes to %p", (input, expected) => {
    expect(WorkspaceSlug(input)).toBe(expected);
  });

  it.each([
    "",
    "a",
    "1abc",
    "-abc",
    "abc_def",
    "ABC def",
    "a".repeat(33),
  ])("rejects %p", (input) => {
    expect(() => WorkspaceSlug(input)).toThrow(ValidationError);
  });
});

describe("slugify", () => {
  it.each([
    ["My Cool Agent", "my-cool-agent"],
    ["Café Olé", "cafe-ole"],
    ["Über-Reviewer 9000!", "uber-reviewer-9000"],
    ["   ---   weird   ---   ", "weird"],
    ["already-lowercase", "already-lowercase"],
    ["Trailing   spaces   ", "trailing-spaces"],
    ["multiple___underscores", "multiple-underscores"],
    ["mixed.dots.and!exclamation", "mixed-dots-and-exclamation"],
    ["Ångström & Søren", "angstrom-soren"],
    ["Ñoño", "nono"],
    ["Crème brûlée", "creme-brulee"],
    ["Reviewer #42", "reviewer-42"],
    ["123 leading digits OK", "123-leading-digits-ok"],
    ["a", "a"],
  ])("turns %p into %p", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it.each([
    ["", ""],
    ["   ", ""],
    ["!!!", ""],
    ["日本語", ""], // CJK has no Latin decomposition; gets stripped
    ["---", ""],
  ])("returns empty for %p (no usable Latin characters)", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("never produces leading or trailing hyphens", () => {
    const samples = ["-foo-", "  bar  ", "!!!baz???", "---qux---"];
    for (const s of samples) {
      const result = slugify(s);
      expect(result.startsWith("-")).toBe(false);
      expect(result.endsWith("-")).toBe(false);
    }
  });

  it("collapses runs of separators to a single hyphen", () => {
    expect(slugify("a    b")).toBe("a-b");
    expect(slugify("a---b")).toBe("a-b");
    expect(slugify("a___b")).toBe("a-b");
    expect(slugify("a !! b")).toBe("a-b");
  });

  it("output passes WorkspaceSlug for typical agent names", () => {
    // Round-trip: slugify a friendly name, then validate as a strict slug.
    // Names that decompose to >= 2 chars starting with a letter should pass.
    expect(() => WorkspaceSlug(slugify("Code Reviewer"))).not.toThrow();
    expect(() => WorkspaceSlug(slugify("Café Helper"))).not.toThrow();
    expect(() => WorkspaceSlug(slugify("Reviewer 42"))).not.toThrow();
  });
});
