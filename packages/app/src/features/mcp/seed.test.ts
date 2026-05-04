import { describe, it, expect } from "bun:test";
import { MCP_SEED, searchSeed, simpleIconUrl } from "./seed.js";

describe("MCP_SEED", () => {
  it("every entry has a unique slug", () => {
    const slugs = MCP_SEED.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every slug fits the catalog name regex", () => {
    const re = /^[a-z][a-z0-9_-]{0,63}$/;
    for (const e of MCP_SEED) {
      expect(re.test(e.slug)).toBe(true);
    }
  });

  it("every entry has the fields its kind requires", () => {
    for (const e of MCP_SEED) {
      if (e.kind === "remote_oauth") {
        // mcp_url can be null when we want the operator to paste it.
        expect(e.mcp_url === null || typeof e.mcp_url === "string").toBe(true);
      }
      if (e.kind === "command") {
        expect(typeof e.command).toBe("string");
        expect(Array.isArray(e.args)).toBe(true);
      }
      if (e.kind === "image") {
        expect(typeof e.image).toBe("string");
      }
    }
  });
});

describe("searchSeed", () => {
  it("empty query returns the full list in seed order", () => {
    expect(searchSeed("").length).toBe(MCP_SEED.length);
    expect(searchSeed("").map((e) => e.slug)).toEqual(
      MCP_SEED.map((e) => e.slug),
    );
  });

  it("exact-name match scores highest", () => {
    const r = searchSeed("linear");
    expect(r[0]?.slug).toBe("linear");
  });

  it("prefix match wins over substring match", () => {
    // "git" prefix-matches "git" + "github"; both should rank above
    // tag-only hits.
    const r = searchSeed("git");
    expect(r.slice(0, 2).map((e) => e.slug).sort()).toEqual([
      "git",
      "github",
    ]);
  });

  it("tag match returns related entries", () => {
    // "files" tag matches Filesystem and Google Drive.
    const r = searchSeed("files");
    const slugs = r.map((e) => e.slug);
    expect(slugs).toContain("filesystem");
    expect(slugs).toContain("google-drive");
  });

  it("no match returns empty", () => {
    expect(searchSeed("zzzzzz-nothing-matches")).toEqual([]);
  });
});

describe("simpleIconUrl", () => {
  it("returns a stable jsDelivr CDN URL", () => {
    expect(simpleIconUrl("linear")).toBe(
      "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/linear.svg",
    );
  });
});
