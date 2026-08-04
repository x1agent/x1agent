import { describe, expect, test } from "bun:test";
import { createAdminMcpRoutes } from "./routes.js";

const resourceUrl = "https://x1agent.example.test/mcp";
const authorizationServerUrl = "https://api.x1agent.example.test";

function app() {
  return createAdminMcpRoutes({
    resourceUrl,
    authorizationServerUrl,
    tokenizer: { sign: () => "unused", verify: () => null },
  });
}

describe("public administrative MCP OAuth bootstrap", () => {
  test("challenges an unauthenticated MCP request with RFC 9728 metadata", async () => {
    const res = await app().request("/mcp", { method: "POST" });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `${authorizationServerUrl}/.well-known/oauth-protected-resource/mcp`,
    );
  });

  test("publishes protected-resource and authorization-server metadata", async () => {
    const server = app();
    const resource = await server.request(
      "/.well-known/oauth-protected-resource/mcp",
    );
    const auth = await server.request("/.well-known/oauth-authorization-server");

    expect(await resource.json()).toMatchObject({
      resource: resourceUrl,
      authorization_servers: [authorizationServerUrl],
    });
    expect(await auth.json()).toMatchObject({
      issuer: authorizationServerUrl,
      authorization_endpoint: `${authorizationServerUrl}/oauth/authorize`,
      registration_endpoint: `${authorizationServerUrl}/oauth/register`,
    });
  });

  test("registers a loopback public client then reaches the browser auth boundary", async () => {
    const server = app();
    const registration = await server.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex",
        redirect_uris: ["http://127.0.0.1:49200/callback"],
      }),
    });
    const client = await registration.json<{ client_id: string }>();
    const auth = await server.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:49200/callback",
        resource: resourceUrl,
        code_challenge: "proof",
        code_challenge_method: "S256",
      })}`,
    );

    expect(registration.status).toBe(201);
    expect(auth.status).toBe(200);
    expect(await auth.text()).toContain("Sign in to X1Agent");
  });
});
