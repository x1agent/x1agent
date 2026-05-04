import { describe, expect, it } from "bun:test";
import { buildMcpOAuthStartUrl } from "./api.js";

/**
 * Regression test for the prod 404 the user reported. The Connect
 * button used to construct `/auth/mcp/start/...` as a same-origin
 * URL — that resolved against `app.x1agent.com`, which doesn't
 * serve the route. The fix is to prepend API_BASE so the popup
 * targets `api.x1agent.com`.
 *
 * If you change the server-side mount path, also update
 * packages/domains/mcp-catalog/src/adapters/hono/oauth-routes.ts.
 */
describe("buildMcpOAuthStartUrl", () => {
  it("prepends apiBase so the URL targets the API host (not the app host)", () => {
    const url = buildMcpOAuthStartUrl({
      apiBase: "https://api.x1agent.com",
      workspaceSlug: "x1agent",
      catalogName: "mercury",
      returnTo: "https://app.x1agent.com/workspaces/x1agent/agents/g/edit",
    });
    expect(url.startsWith("https://api.x1agent.com/")).toBe(true);
  });

  it("matches the action-first /auth/mcp/start/:slug/:name route shape", () => {
    const url = buildMcpOAuthStartUrl({
      apiBase: "https://api.x1agent.com",
      workspaceSlug: "x1agent",
      catalogName: "mercury",
      returnTo: "https://app.x1agent.com/x",
    });
    // Path order matters — the server mounts /start/:slug/:name. An
    // earlier draft built /:slug/:name/start which 404s.
    expect(url).toContain("/auth/mcp/start/x1agent/mercury?");
  });

  it("URL-encodes the return_to value", () => {
    const url = buildMcpOAuthStartUrl({
      apiBase: "https://api.x1agent.com",
      workspaceSlug: "x1agent",
      catalogName: "mercury",
      returnTo: "https://app.x1agent.com/path?tab=mcp&x=1",
    });
    expect(url).toContain(
      `return_to=${encodeURIComponent("https://app.x1agent.com/path?tab=mcp&x=1")}`,
    );
  });
});
