import { describe, it, expect } from "bun:test";
import { loadMasterKey } from "@x1agent/domain-workspace-secrets";
import { UserTokenService } from "./user-token-service.js";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import type { CatalogName } from "../domain/catalog-name.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";
import type {
  EncryptedOAuthClientBlob,
  OAuthClientRepository,
} from "../ports/oauth-client-repository.js";
import type { UserTokenRepository } from "../ports/user-token-repository.js";
import type { RegisteredClient } from "./oauth-dcr.js";

const TEST_KEY = loadMasterKey(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const fakeAuthServer = {
  issuer: "https://mercury.example.com",
  authorization_endpoint: "https://mercury.example.com/oauth/authorize",
  token_endpoint: "https://mercury.example.com/oauth/token",
  registration_endpoint: "https://mercury.example.com/oauth/register",
  code_challenge_methods_supported: ["S256"],
};

function fakeEntry(): CatalogEntry {
  return {
    id: "cat-mercury-1",
    workspaceId: "ws-1",
    name: "mercury" as unknown as CatalogName,
    displayName: "Mercury",
    kind: "remote_oauth",
    image: null,
    command: null,
    args: [],
    url: "https://mercury.example.com/mcp",
    oauthAuthorizationServer: fakeAuthServer,
    manifest: { env: {}, tool_scopes: {} },
    description: "",
    createdAt: new Date("2026-05-03T21:37:35Z"),
    updatedAt: new Date("2026-05-03T21:37:35Z"),
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
  upsert = async (blob: EncryptedOAuthClientBlob) => {
    this.upsertCalls++;
    this.blobs.set(blob.catalogEntryId, blob);
  };
  getBlob = async (id: string) => this.blobs.get(id) ?? null;
  delete = async (id: string) => {
    this.blobs.delete(id);
  };
}

class FakeUserTokens implements UserTokenRepository {
  upsert = async () => {
    throw new Error("not used");
  };
  getEncrypted = async () => null;
  listForUser = async () => [];
  delete = async () => true;
}

describe("UserTokenService.start — self-heals when oauth_clients row is missing", () => {
  it("re-runs DCR and persists the new client, then proceeds to authorize URL", async () => {
    const catalog = new FakeCatalog(fakeEntry());
    const oauthClients = new FakeOAuthClients();
    let dcrCalls = 0;
    const registerClient = async (): Promise<RegisteredClient> => {
      dcrCalls++;
      return {
        clientId: "freshly-registered-client-id",
        clientSecret: "freshly-issued-secret",
        tokenEndpointAuthMethod: "client_secret_basic",
      };
    };

    const svc = new UserTokenService({
      catalog,
      oauthClients,
      userTokens: new FakeUserTokens(),
      cipherKey: TEST_KEY,
      redirectUriFor: ({ workspaceSlug, catalogName }) =>
        `https://api.example.com/auth/mcp/callback/${workspaceSlug}/${catalogName}`,
      workspaceSlugFor: async () => "acme",
      registerClient: registerClient as never,
    });

    const result = await svc.start({
      workspaceId: "ws-1",
      catalogEntryName: "mercury",
      userId: "user-1",
      returnTo: "https://app.example.com/workspaces/acme",
    });

    expect(dcrCalls).toBe(1);
    expect(oauthClients.upsertCalls).toBe(1);
    expect(oauthClients.blobs.get("cat-mercury-1")?.clientId).toBe(
      "freshly-registered-client-id",
    );
    expect(result.authorizeUrl).toContain(
      "client_id=freshly-registered-client-id",
    );
    expect(result.redirectUri).toBe(
      "https://api.example.com/auth/mcp/callback/acme/mercury",
    );
  });

  it("does not call DCR when an oauth_clients row already exists", async () => {
    const catalog = new FakeCatalog(fakeEntry());
    const oauthClients = new FakeOAuthClients();
    oauthClients.blobs.set("cat-mercury-1", {
      catalogEntryId: "cat-mercury-1",
      clientId: "preexisting-client-id",
      tokenEndpointAuthMethod: "client_secret_basic",
      ciphertext: new Uint8Array([1, 2, 3]),
      nonce: new Uint8Array([4, 5, 6]),
      authTag: new Uint8Array([7, 8, 9]),
    });
    let dcrCalls = 0;
    const registerClient = async () => {
      dcrCalls++;
      return {
        clientId: "should-not-be-used",
        clientSecret: "should-not-be-used",
        tokenEndpointAuthMethod: "client_secret_basic" as const,
      };
    };

    const svc = new UserTokenService({
      catalog,
      oauthClients,
      userTokens: new FakeUserTokens(),
      cipherKey: TEST_KEY,
      redirectUriFor: ({ workspaceSlug, catalogName }) =>
        `https://api.example.com/auth/mcp/callback/${workspaceSlug}/${catalogName}`,
      workspaceSlugFor: async () => "acme",
      registerClient: registerClient as never,
    });

    const result = await svc.start({
      workspaceId: "ws-1",
      catalogEntryName: "mercury",
      userId: "user-1",
      returnTo: "https://app.example.com/workspaces/acme",
    });

    expect(dcrCalls).toBe(0);
    expect(oauthClients.upsertCalls).toBe(0);
    expect(result.authorizeUrl).toContain("client_id=preexisting-client-id");
  });
});
