import { describe, it, expect } from "bun:test";
import { ValidationError } from "@x1agent/kernel";
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  StaleClientRegistrationError,
} from "./oauth-flow.js";
import type { SafeFetch, SafeFetchResponse } from "./ssrf-safe-fetch.js";

/**
 * Pins the self-heal-on-upstream-rejection behaviour. The previous
 * release only re-DCR'd when the `mcp_oauth_clients` row was missing;
 * a row that EXISTS but was revoked / expired upstream (Miro 2026-06-
 * 02 incident) silently 401'd every Connect attempt and the user had
 * to delete the catalog entry to recover. RFC 6749 §5.2 says
 * `invalid_client` / `unauthorized_client` are the "your DCR client
 * id is dead, re-register" signals; recognise them and bubble a typed
 * error the caller can use to wipe the row + redirect to /start.
 */
function stubFetcher(handler: (url: string) => Response | Promise<Response>): SafeFetch {
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

const authServer = {
  issuer: "https://mcp.example.com/",
  authorization_endpoint: "https://mcp.example.com/authorize",
  token_endpoint: "https://mcp.example.com/token",
  registration_endpoint: "https://mcp.example.com/register",
  code_challenge_methods_supported: ["S256"] as string[],
};

function inputs() {
  return {
    authorizationServer: authServer,
    clientId: "stale-client",
    clientSecret: "stale-secret",
    authMethod: "client_secret_basic" as const,
    redirectUri: "https://api.example.com/auth/mcp/callback/acme/miro",
    code: "auth-code",
    codeVerifier: "verifier",
  };
}

describe("exchangeCodeForTokens — stale-client-registration self-heal signal", () => {
  it("throws StaleClientRegistrationError on 401 invalid_client", async () => {
    const fetcher = stubFetcher(() =>
      new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: "client authentication failed",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    let logged: { endpoint: string; status: number; body: string } | null = null;
    await expect(
      exchangeCodeForTokens(inputs(), {
        fetcher,
        logUpstreamError: (info) => {
          logged = info;
        },
      }),
    ).rejects.toBeInstanceOf(StaleClientRegistrationError);
    // The body is logged server-side so ops can see WHY the upstream
    // rejected without it ever reaching the user.
    expect(logged?.status).toBe(401);
    expect(logged?.body).toContain("invalid_client");
  });

  it("throws StaleClientRegistrationError on 401 unauthorized_client", async () => {
    const fetcher = stubFetcher(() =>
      new Response(JSON.stringify({ error: "unauthorized_client" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      exchangeCodeForTokens(inputs(), { fetcher }),
    ).rejects.toBeInstanceOf(StaleClientRegistrationError);
  });

  it("throws a regular ValidationError on 401 invalid_grant (user replay, NOT client rotation)", async () => {
    // invalid_grant means the auth code is gone / replayed — user
    // should retry the OAuth flow but the DCR client is fine. We
    // MUST NOT wipe the row here.
    const fetcher = stubFetcher(() =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    let caught: unknown = null;
    try {
      await exchangeCodeForTokens(inputs(), { fetcher });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof StaleClientRegistrationError).toBe(false);
    expect(caught).toBeInstanceOf(ValidationError);
  });

  it("throws a regular ValidationError on 400/500 token errors that aren't client-rotation", async () => {
    const fetcher = stubFetcher(() =>
      new Response(JSON.stringify({ error: "server_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    let caught: unknown = null;
    try {
      await exchangeCodeForTokens(inputs(), { fetcher });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof StaleClientRegistrationError).toBe(false);
    expect(caught).toBeInstanceOf(ValidationError);
  });
});

describe("refreshAccessToken — same stale-client signal", () => {
  it("throws StaleClientRegistrationError on 401 invalid_client at refresh", async () => {
    const fetcher = stubFetcher(() =>
      new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      refreshAccessToken(
        {
          authorizationServer: authServer,
          clientId: "stale-client",
          clientSecret: "stale-secret",
          authMethod: "client_secret_basic",
          refreshToken: "rt",
        },
        { fetcher },
      ),
    ).rejects.toBeInstanceOf(StaleClientRegistrationError);
  });
});
