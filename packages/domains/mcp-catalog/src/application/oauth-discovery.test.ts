import { describe, it, expect } from "bun:test";
import { discoverMcpServer } from "./oauth-discovery.js";
import { ValidationError } from "@x1agent/kernel";
import type { SafeFetch, SafeFetchResponse } from "./ssrf-safe-fetch.js";

// Tests inject a stub fetcher so they don't depend on real DNS / network.
// Production paths use the SSRF-safe default; the unit tests here only
// care about discovery's branching logic.
type Handler = (url: string) => Response | Promise<Response>;

function stubFetcher(handler: Handler): SafeFetch {
  return async (url): Promise<SafeFetchResponse> => {
    const res = await handler(url);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const buf = await res.arrayBuffer();
    const status = res.status;
    return {
      status,
      ok: status >= 200 && status < 300,
      url,
      headers,
      text: async () => new TextDecoder().decode(buf),
      json: async <T = unknown>() =>
        JSON.parse(new TextDecoder().decode(buf)) as T,
    };
  };
}

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
    const fetcher = stubFetcher(async (url) => {
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify(validResource), { status: 200 });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify(validAuthServer), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const r = await discoverMcpServer("https://mcp.example.com/mcp", { fetcher });
    expect(r.resource.resource).toBe("https://mcp.example.com/mcp");
    expect(r.authorizationServer.registration_endpoint).toBe(
      "https://mcp.example.com/register",
    );
  });

  it("rejects when resource metadata is missing", async () => {
    const fetcher = stubFetcher(async () => new Response("not found", { status: 404 }));
    await expect(
      discoverMcpServer("https://mcp.example.com/mcp", { fetcher }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when authorization_servers is empty", async () => {
    const fetcher = stubFetcher(async (url) => {
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
      discoverMcpServer("https://mcp.example.com/mcp", { fetcher }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when registration_endpoint is missing", async () => {
    const fetcher = stubFetcher(async (url) => {
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
      discoverMcpServer("https://mcp.example.com/mcp", { fetcher }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when PKCE S256 isn't supported", async () => {
    const fetcher = stubFetcher(async (url) => {
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
      discoverMcpServer("https://mcp.example.com/mcp", { fetcher }),
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

  // Sentry-style: the resource path is /mcp, and the protected-resource
  // metadata document lives at the spec-canonical suffix-on-origin URL
  // (RFC 9728 §3.1). Other servers (Mercury, Notion) use the path-rooted
  // form. Both must work.
  it("discovers via suffix-on-origin (RFC 9728 canonical) when path-rooted 404s", async () => {
    const seen: string[] = [];
    const fetcher = stubFetcher(async (url) => {
      seen.push(url);
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
        return new Response(JSON.stringify(validResource), { status: 200 });
      }
      if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(validAuthServer), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const r = await discoverMcpServer("https://mcp.example.com/mcp", { fetcher });
    expect(r.resource.resource).toBe("https://mcp.example.com/mcp");
    expect(seen).toContain(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("still discovers when only the path-rooted-on-resource form is served (Mercury-style)", async () => {
    const fetcher = stubFetcher(async (url) => {
      if (url === "https://mcp.example.com/mcp/.well-known/oauth-protected-resource") {
        return new Response(JSON.stringify(validResource), { status: 200 });
      }
      if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(validAuthServer), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const r = await discoverMcpServer("https://mcp.example.com/mcp", { fetcher });
    expect(r.resource.resource).toBe("https://mcp.example.com/mcp");
  });

  it("does not double-probe when the resource is at the origin root", async () => {
    const seen: string[] = [];
    const fetcher = stubFetcher(async (url) => {
      seen.push(url);
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return new Response(JSON.stringify(validResource), { status: 200 });
      }
      if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(validAuthServer), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    await discoverMcpServer("https://mcp.example.com/", { fetcher });
    const protectedHits = seen.filter((u) =>
      u.includes("/.well-known/oauth-protected-resource"),
    );
    expect(protectedHits.length).toBe(1);
  });

  // Regression for X1A-125: an attacker-controlled protected-resource
  // document can list a metadata-host URL as authorization_servers[0].
  // The SSRF guard must run on that URL — discovery delegates to safeFetch
  // (this test substitutes a fetcher that fails on private hosts, mimicking
  // the production guard).
  it("re-validates authorization_servers[0] through the same fetcher (no trust)", async () => {
    const seen: string[] = [];
    const fetcher = stubFetcher(async (url) => {
      seen.push(url);
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return new Response(
          JSON.stringify({
            resource: "https://mcp.example.com/",
            // Attacker-supplied URL — the production safeFetch would
            // refuse this, but even in this stub we assert the fetcher
            // is actually called with it (= no path bypasses the guard).
            authorization_servers: ["https://attacker.example/"],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://attacker.example/")) {
        // Simulate the production SSRF guard refusing to fetch.
        throw new ValidationError(
          "url",
          "URL resolves to a private or reserved address",
        );
      }
      return new Response("not found", { status: 404 });
    });
    await expect(
      discoverMcpServer("https://mcp.example.com/", { fetcher }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      seen.some((u) => u.startsWith("https://attacker.example/")),
    ).toBe(true);
  });
});
