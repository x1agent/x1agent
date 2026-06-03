import { describe, it, expect } from "bun:test";
import { loadMasterKey } from "@x1agent/domain-workspace-secrets";
import {
  ClientRegistrationRecoveredError,
  UserTokenService,
} from "./user-token-service.js";
import { StaleClientRegistrationError } from "./oauth-flow.js";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import type { CatalogName } from "../domain/catalog-name.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";
import type {
  EncryptedOAuthClientBlob,
  OAuthClientRepository,
} from "../ports/oauth-client-repository.js";
import type {
  DecryptedUserTokenBlob,
  EncryptedUserTokenInput,
  UserTokenRepository,
} from "../ports/user-token-repository.js";
import type { UserMcpToken } from "../domain/user-token.js";

const TEST_KEY = loadMasterKey(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const fakeAuthServer = {
  issuer: "https://mcp.example.com",
  authorization_endpoint: "https://mcp.example.com/authorize",
  token_endpoint: "https://mcp.example.com/token",
  registration_endpoint: "https://mcp.example.com/register",
  code_challenge_methods_supported: ["S256"],
};

function fakeEntry(): CatalogEntry {
  return {
    id: "cat-1",
    workspaceId: "ws-1",
    name: "mercury" as unknown as CatalogName,
    displayName: "Mercury",
    kind: "remote_oauth",
    image: null,
    command: null,
    args: [],
    url: "https://mcp.example.com/mcp",
    oauthAuthorizationServer: fakeAuthServer,
    manifest: { env: {}, tool_scopes: {} },
    description: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
  };
}

class FakeCatalog implements CatalogRepository {
  constructor(private readonly entry: CatalogEntry) {}
  list = async () => [this.entry];
  getById = async (_w: string, id: string) =>
    id === this.entry.id ? this.entry : null;
  getByName = async (_w: string, n: CatalogName) =>
    (n as unknown as string) === (this.entry.name as unknown as string)
      ? this.entry
      : null;
  upsert = async () => this.entry;
  delete = async () => true;
}

class FakeOAuthClients implements OAuthClientRepository {
  blobs = new Map<string, EncryptedOAuthClientBlob>();
  upsertCalls = 0;
  deleteCalls: string[] = [];
  upsert = async (blob: EncryptedOAuthClientBlob) => {
    this.upsertCalls++;
    this.blobs.set(blob.catalogEntryId, blob);
  };
  getBlob = async (id: string) => this.blobs.get(id) ?? null;
  delete = async (id: string) => {
    this.deleteCalls.push(id);
    this.blobs.delete(id);
  };
}

class FakeUserTokens implements UserTokenRepository {
  upsertCalls: EncryptedUserTokenInput[] = [];
  upsert = async (input: EncryptedUserTokenInput): Promise<UserMcpToken> => {
    this.upsertCalls.push(input);
    return {
      userId: input.userId,
      catalogEntryId: input.catalogEntryId,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      scope: input.scope,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never;
  };
  getEncrypted = async (): Promise<DecryptedUserTokenBlob | null> => null;
  listForUser = async () => [];
  delete = async () => true;
}

function makeService(opts: {
  exchangeImpl: () => Promise<{ access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }>;
  oauthClients?: FakeOAuthClients;
  preExistingBlob?: boolean;
}) {
  const oauthClients = opts.oauthClients ?? new FakeOAuthClients();
  if (opts.preExistingBlob) {
    oauthClients.blobs.set("cat-1", {
      catalogEntryId: "cat-1",
      clientId: "preexisting-client-id",
      tokenEndpointAuthMethod: "client_secret_basic",
      // Just placeholder bytes — exchangeImpl is stubbed so the
      // decrypt path doesn't actually run against real cipher data.
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
    });
  }
  const userTokens = new FakeUserTokens();
  const svc = new UserTokenService({
    catalog: new FakeCatalog(fakeEntry()),
    oauthClients,
    userTokens,
    cipherKey: TEST_KEY,
    redirectUriFor: ({ workspaceSlug, catalogName }) =>
      `https://api.example.com/auth/mcp/callback/${workspaceSlug}/${catalogName}`,
    workspaceSlugFor: async () => "acme",
    registerClient: async () => ({
      clientId: "freshly-registered-id",
      clientSecret: "freshly-issued-secret",
      tokenEndpointAuthMethod: "client_secret_basic",
    }),
  });
  return { svc, oauthClients, userTokens };
}

describe("UserTokenService.start — missing-row self-heal", () => {
  it("re-DCRs and persists when getBlob returns null (no row exists)", async () => {
    const { svc, oauthClients } = makeService({
      exchangeImpl: async () => ({
        access_token: "at",
        token_type: "Bearer",
      }),
      preExistingBlob: false,
    });
    const result = await svc.start({
      workspaceId: "ws-1",
      catalogEntryName: "mercury",
      userId: "user-1",
      returnTo: "https://app.example.com/workspaces/acme",
    });
    expect(oauthClients.upsertCalls).toBe(1);
    expect(oauthClients.blobs.get("cat-1")?.clientId).toBe(
      "freshly-registered-id",
    );
    expect(result.authorizeUrl).toContain(
      "client_id=freshly-registered-id",
    );
  });

  it("does not call DCR when a row already exists (normal-flow no-op)", async () => {
    const { svc, oauthClients } = makeService({
      exchangeImpl: async () => ({ access_token: "at", token_type: "Bearer" }),
      preExistingBlob: true,
    });
    const result = await svc.start({
      workspaceId: "ws-1",
      catalogEntryName: "mercury",
      userId: "user-1",
      returnTo: "https://app.example.com/workspaces/acme",
    });
    // Hit the existing blob; no upsert.
    expect(oauthClients.upsertCalls).toBe(0);
    expect(result.authorizeUrl).toContain("client_id=preexisting-client-id");
  });
});

describe("UserTokenService.complete — upstream-rejection self-heal", () => {
  it("wipes the oauth_clients row and throws ClientRegistrationRecoveredError when exchange fails with invalid_client", async () => {
    const oauthClients = new FakeOAuthClients();
    const svc = new UserTokenService({
      catalog: new FakeCatalog(fakeEntry()),
      oauthClients,
      userTokens: new FakeUserTokens(),
      cipherKey: TEST_KEY,
      redirectUriFor: ({ workspaceSlug, catalogName }) =>
        `https://api.example.com/auth/mcp/callback/${workspaceSlug}/${catalogName}`,
      workspaceSlugFor: async () => "acme",
      registerClient: async () => ({
        clientId: "freshly-registered-id",
        clientSecret: "freshly-issued-secret",
        tokenEndpointAuthMethod: "client_secret_basic",
      }),
      // Stub the token-exchange dependency via the test seam so we
      // raise the typed error the live oauth-flow would raise on a
      // 401 invalid_client (pinned by oauth-flow-stale-client.test.ts).
      // Skips the safeFetch URL validation we'd otherwise have to
      // pierce.
      exchangeCodeForTokens: (async () => {
        throw new StaleClientRegistrationError(
          "invalid_client",
          "https://mcp.example.com/token",
        );
      }) as never,
    });

    const flowState = await svc.start({
      workspaceId: "ws-1",
      catalogEntryName: "mercury",
      userId: "user-1",
      returnTo: "https://app.example.com/workspaces/acme",
    });

    // After start(), there IS a row. Now drive complete(); the
    // stubbed exchange raises StaleClientRegistrationError, which
    // complete() catches and converts to the recovery signal.
    await expect(
      svc.complete({
        workspaceId: "ws-1",
        catalogEntryName: "mercury",
        userId: "user-1",
        code: "fake-code",
        state: flowState.flowState.state,
        flowState: flowState.flowState,
      }),
    ).rejects.toBeInstanceOf(ClientRegistrationRecoveredError);

    // The row was wiped — that's the signal /start uses on the next
    // hop to re-DCR via the missing-row self-heal path above.
    expect(oauthClients.deleteCalls).toContain("cat-1");
    expect(oauthClients.blobs.get("cat-1")).toBeUndefined();
  });

  it("bubbles non-recovery errors unchanged (e.g. invalid_grant from user replay)", async () => {
    const oauthClients = new FakeOAuthClients();
    const svc = new UserTokenService({
      catalog: new FakeCatalog(fakeEntry()),
      oauthClients,
      userTokens: new FakeUserTokens(),
      cipherKey: TEST_KEY,
      redirectUriFor: ({ workspaceSlug, catalogName }) =>
        `https://api.example.com/auth/mcp/callback/${workspaceSlug}/${catalogName}`,
      workspaceSlugFor: async () => "acme",
      registerClient: async () => ({
        clientId: "freshly-registered-id",
        clientSecret: "freshly-issued-secret",
        tokenEndpointAuthMethod: "client_secret_basic",
      }),
      // Stub exchange to throw a non-recovery ValidationError, as if
      // the upstream returned invalid_grant (user replayed an
      // already-used auth code). Self-heal MUST NOT fire here.
      exchangeCodeForTokens: (async () => {
        const { ValidationError } = await import("@x1agent/kernel");
        throw new ValidationError("token", "code exchange failed: HTTP 401");
      }) as never,
    });

    const flowState = await svc.start({
      workspaceId: "ws-1",
      catalogEntryName: "mercury",
      userId: "user-1",
      returnTo: "https://app.example.com/workspaces/acme",
    });

    let caught: unknown = null;
    try {
      await svc.complete({
        workspaceId: "ws-1",
        catalogEntryName: "mercury",
        userId: "user-1",
        code: "fake-code",
        state: flowState.flowState.state,
        flowState: flowState.flowState,
      });
    } catch (err) {
      caught = err;
    }
    // NOT a recovery — user replays / retries, the row stays.
    expect(caught instanceof ClientRegistrationRecoveredError).toBe(false);
    expect(caught instanceof StaleClientRegistrationError).toBe(false);
    expect(oauthClients.deleteCalls).not.toContain("cat-1");
    expect(oauthClients.blobs.get("cat-1")).toBeDefined();
  });
});
