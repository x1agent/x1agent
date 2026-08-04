import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freshTestDb, dropTestDb } from "../test-helpers.js";
import { PostgresAdminMcpOAuthStore } from "./oauth-store.js";

const TEST_DB = "x1agent_admin_mcp_oauth_test";
const resource = "https://x1agent.example.test/mcp";
const redirectUri = "http://127.0.0.1:49123/callback";
const verifier = "integration-verifier-long-enough-for-pkce-s256-check";
const challenge = createHash("sha256").update(verifier).digest("base64url");

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let userId: string;
let store: PostgresAdminMcpOAuthStore;

describe("PostgresAdminMcpOAuthStore", () => {
  beforeAll(async () => {
    const db = await freshTestDb(TEST_DB);
    dbSql = db.sql;
    const rows = await dbSql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES ('mcp-user@example.com', 'MCP User')
      RETURNING id
    `;
    userId = rows[0]!.id;
    store = new PostgresAdminMcpOAuthStore(dbSql);
  }, 30_000);

  afterAll(async () => {
    if (dbSql) await dbSql.end();
    await dropTestDb(TEST_DB);
  }, 30_000);

  test("persists clients, hashes credentials, enforces PKCE, and rotates refresh tokens", async () => {
    const client = await store.registerClient({
      clientName: "Codex",
      redirectUris: [redirectUri],
    });
    expect((await store.findClient(client.clientId))?.redirectUris).toEqual([
      redirectUri,
    ]);

    const consentToken = await store.createAuthorizationRequest({
      clientId: client.clientId,
      userId,
      redirectUri,
      resource,
      scope: "x1.workspaces.read",
      codeChallenge: challenge,
      state: "codex-state",
    });
    const replacementConsentToken = await store.createAuthorizationRequest({
      clientId: client.clientId,
      userId,
      redirectUri,
      resource,
      scope: "x1.workspaces.read",
      codeChallenge: challenge,
      state: "codex-state",
    });
    expect(
      await store.consumeAuthorizationRequest({ token: consentToken, userId }),
    ).toBeNull();
    expect(
      await store.consumeAuthorizationRequest({
        token: replacementConsentToken,
        userId: "00000000-0000-0000-0000-000000000000",
      }),
    ).toBeNull();
    expect(
      await store.consumeAuthorizationRequest({
        token: replacementConsentToken,
        userId,
      }),
    ).toMatchObject({
      clientId: client.clientId,
      userId,
      redirectUri,
      resource,
      state: "codex-state",
    });
    expect(
      await store.consumeAuthorizationRequest({
        token: replacementConsentToken,
        userId,
      }),
    ).toBeNull();

    // A bad verifier spends the one-time code and cannot be retried.
    const badCode = await store.authorize({
      clientId: client.clientId,
      userId,
      redirectUri,
      resource,
      scope: "x1.workspaces.read",
      codeChallenge: challenge,
    });
    expect(
      await store.exchangeAuthorizationCode({
        code: badCode,
        clientId: client.clientId,
        redirectUri,
        resource,
        codeVerifier: "wrong-verifier-that-is-still-long-enough-for-pkce-check",
      }),
    ).toBeNull();
    expect(
      await store.exchangeAuthorizationCode({
        code: badCode,
        clientId: client.clientId,
        redirectUri,
        resource,
        codeVerifier: verifier,
      }),
    ).toBeNull();

    const code = await store.authorize({
      clientId: client.clientId,
      userId,
      redirectUri,
      resource,
      scope: "x1.workspaces.read",
      codeChallenge: challenge,
    });
    const pair = await store.exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      redirectUri,
      resource,
      codeVerifier: verifier,
    });
    expect(pair).not.toBeNull();
    expect(
      await store.verifyAccessToken(pair!.accessToken, resource),
    ).toMatchObject({
      userId,
      clientId: client.clientId,
      scopes: ["x1.workspaces.read"],
    });

    const rawMatches = await dbSql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM admin_mcp_oauth_tokens
      WHERE token_hash IN (${pair!.accessToken}, ${pair!.refreshToken})
    `;
    expect(rawMatches[0]!.n).toBe(0);

    const rotated = await store.exchangeRefreshToken({
      refreshToken: pair!.refreshToken,
      clientId: client.clientId,
      resource,
    });
    expect(rotated).not.toBeNull();
    expect(rotated!.refreshToken).not.toBe(pair!.refreshToken);

    // Reusing the spent refresh token revokes its entire family, including
    // the newly-issued access token.
    expect(
      await store.exchangeRefreshToken({
        refreshToken: pair!.refreshToken,
        clientId: client.clientId,
        resource,
      }),
    ).toBeNull();
    expect(
      await store.verifyAccessToken(rotated!.accessToken, resource),
    ).toBeNull();
  });
});
