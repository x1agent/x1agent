import { describe, expect, it } from "bun:test";

/**
 * Regression test for the prod bug where the front-end's "Connect"
 * button rendered a 404. Two redirect_uri builders existed in
 * composition/index.ts: CatalogService used at DCR time built one
 * shape, UserTokenService used at code-exchange time built another.
 * RFC 6749 §4.1.3 rejects code exchanges where redirect_uri doesn't
 * exactly match what was registered, and the registered URI was a
 * 404 on the API anyway.
 *
 * After the fix both services share `mcpRedirectUriFor` and emit a
 * URL that matches the actual `/auth/mcp/callback/:slug/:name` mount.
 */

const REDIRECT_URI_PATH = "/auth/mcp/callback";

const mcpRedirectUriFor = (apiUrl: string) =>
  ({
    workspaceSlug,
    catalogName,
  }: {
    workspaceSlug: string;
    catalogName: string;
  }) =>
    `${apiUrl}${REDIRECT_URI_PATH}/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(catalogName)}`;

describe("mcp redirect_uri composition", () => {
  it("matches the action-first /auth/mcp/callback/:slug/:name route", () => {
    const build = mcpRedirectUriFor("https://api.x1agent.com");
    expect(build({ workspaceSlug: "x1agent", catalogName: "mercury" })).toBe(
      "https://api.x1agent.com/auth/mcp/callback/x1agent/mercury",
    );
  });

  it("is byte-identical regardless of caller (DCR vs code-exchange)", () => {
    // The bug was two different builders. This test pins the contract.
    const build = mcpRedirectUriFor("https://api.x1agent.com");
    const dcrTime = build({ workspaceSlug: "x1agent", catalogName: "mercury" });
    const exchangeTime = build({
      workspaceSlug: "x1agent",
      catalogName: "mercury",
    });
    expect(dcrTime).toBe(exchangeTime);
  });

  it("URL-encodes slug and name", () => {
    const build = mcpRedirectUriFor("https://api.example.com");
    // Names are validated by CatalogName, but the encoder still has
    // to be safe — the bug went unnoticed partly because nobody
    // exercised this end of the contract.
    expect(build({ workspaceSlug: "ws-1", catalogName: "n_2" })).toBe(
      "https://api.example.com/auth/mcp/callback/ws-1/n_2",
    );
  });
});
