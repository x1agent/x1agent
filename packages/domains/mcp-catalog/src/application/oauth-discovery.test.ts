import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { discoverMcpServer } from "./oauth-discovery.js";
import { ValidationError } from "@x1agent/kernel";

let originalFetch: typeof fetch;
type FetchHandler = (url: string) => Response | Promise<Response>;

// Tests use mocked fetch and reserved-name hosts, so the real DNS-based
// SSRF guard would reject them as unresolvable. Skip the host check in
// these unit tests; production paths use the strict default.
const noopHostCheck = async () => {};

function mockFetch(handler: FetchHandler) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validResource = {
  resource: "https://mcp.example.com/mcp",
  authorization_servers: ["https://mcp.example.com"],
  scopes_supported: ["read", "offline_access"],
};

const validAuthServer = {
  issuer: "https://mcp.example.com/",
  authorization_endpoint: "https://mcp.example.com/authorize",
  token_endpoint: "https://mcp.example.com/token",
  registration_endpoint: "https://mcp.example.com/register",
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["read", "offline_access"],
};

describe("discoverMcpServer", () => {
  it("returns resource + auth-server metadata on the happy path", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify(validResource), { status: 200 });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify(validAuthServer), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const r = await discoverMcpServer("https://mcp.example.com/mcp", {
      assertHostAllowed: noopHostCheck,
    });
    expect(r.resource.resource).toBe("https://mcp.example.com/mcp");
    expect(r.authorizationServer.registration_endpoint).toBe(
      "https://mcp.example.com/register",
    );
  });

  it("rejects when resource metadata is missing", async () => {
    mockFetch(async () => new Response("not found", { status: 404 }));
    await expect(
      discoverMcpServer("https://mcp.example.com/mcp", { assertHostAllowed: noopHostCheck }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when authorization_servers is empty", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: [],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    await expect(
      discoverMcpServer("https://mcp.example.com/mcp", { assertHostAllowed: noopHostCheck }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when registration_endpoint is missing", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify(validResource), { status: 200 });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        const noReg = { ...validAuthServer };
        delete (noReg as { registration_endpoint?: string }).registration_endpoint;
        return new Response(JSON.stringify(noReg), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    await expect(
      discoverMcpServer("https://mcp.example.com/mcp", { assertHostAllowed: noopHostCheck }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when PKCE S256 isn't supported", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify(validResource), { status: 200 });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        const noPkce = { ...validAuthServer, code_challenge_methods_supported: ["plain"] };
        return new Response(JSON.stringify(noPkce), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    await expect(
      discoverMcpServer("https://mcp.example.com/mcp", { assertHostAllowed: noopHostCheck }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects malformed URLs", async () => {
    await expect(
      discoverMcpServer("not a url"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      discoverMcpServer("ftp://example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
