import { ValidationError } from "@x1agent/kernel";
import { encrypt, type MasterKey } from "@x1agent/domain-workspace-secrets";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import { CatalogName } from "../domain/catalog-name.js";
import { validateManifest } from "../domain/manifest.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";
import type { OAuthClientRepository } from "../ports/oauth-client-repository.js";
import { discoverMcpServer } from "./oauth-discovery.js";
import { registerOAuthClient } from "./oauth-dcr.js";

export interface CatalogSetInput {
  workspaceId: string;
  name: string;
  displayName?: string | null;
  /** Shape selector. Defaults to 'stdio' for back-compat with existing
   * callers that don't supply kind. */
  kind?: "stdio" | "remote_oauth";
  // ── stdio shape ──
  image?: string | null;
  command?: string | null;
  args?: string[];
  // ── remote_oauth shape ──
  url?: string | null;
  manifest: unknown;
  description?: string;
  createdBy: string | null;
}

const COMMAND_RE = /^[A-Za-z0-9_./-]{1,64}$/;

/**
 * Service-level dependencies for the remote_oauth flow.
 *
 * `redirectUriFor` builds the OAuth callback URL the api will receive
 * the authorization code at. We thread this through as a function (not
 * a string) because it's per-catalog-entry: callbacks are routed as
 * `/auth/mcp/<workspace-slug>/<catalog-name>/callback`. The api root
 * URL is composition-known, so the api wires this up.
 *
 * `cipherKey` + `oauthClients` enable encryption of the DCR-issued
 * client_secret. We import the cipher from workspace-secrets to avoid
 * shipping a second AES implementation.
 */
export interface RemoteOAuthDeps {
  redirectUriFor: (input: {
    workspaceSlug: string;
    catalogName: string;
  }) => string;
  cipherKey: MasterKey;
  oauthClients: OAuthClientRepository;
  /** Override DCR for tests; defaults to registerOAuthClient. */
  registerClient?: typeof registerOAuthClient;
  /** Override discovery for tests; defaults to discoverMcpServer. */
  discover?: typeof discoverMcpServer;
}

export class CatalogService {
  constructor(
    private readonly repo: CatalogRepository,
    private readonly remoteOAuth?: RemoteOAuthDeps & {
      /** Workspace slug resolver; the route layer knows the slug, but
       * domain only sees the workspaceId, so the route passes a callback. */
      workspaceSlugFor: (workspaceId: string) => Promise<string | null>;
    },
  ) {}

  list(workspaceId: string): Promise<CatalogEntry[]> {
    return this.repo.list(workspaceId);
  }

  get(workspaceId: string, id: string): Promise<CatalogEntry | null> {
    return this.repo.getById(workspaceId, id);
  }

  async set(input: CatalogSetInput): Promise<CatalogEntry> {
    const name = CatalogName(input.name);
    const manifest = validateManifest(input.manifest);
    const displayName =
      typeof input.displayName === "string" &&
      input.displayName.trim().length > 0
        ? input.displayName.trim()
        : null;
    const kind = input.kind ?? "stdio";

    if (kind === "stdio") {
      return this.setStdio({
        ...input,
        name,
        manifest,
        displayName,
      });
    }
    if (kind === "remote_oauth") {
      return this.setRemoteOAuth({
        ...input,
        name,
        manifest,
        displayName,
      });
    }
    throw new ValidationError("kind", `unknown kind '${kind}'`);
  }

  private async setStdio(input: {
    workspaceId: string;
    name: ReturnType<typeof CatalogName>;
    displayName: string | null;
    image?: string | null;
    command?: string | null;
    args?: string[];
    manifest: ReturnType<typeof validateManifest>;
    description?: string;
    createdBy: string | null;
  }): Promise<CatalogEntry> {
    const rawImage =
      typeof input.image === "string" ? input.image.trim() : "";
    const rawCommand =
      typeof input.command === "string" ? input.command.trim() : "";

    if (rawImage && rawCommand) {
      throw new ValidationError(
        "image",
        "set either image OR command, not both",
      );
    }
    if (!rawImage && !rawCommand) {
      throw new ValidationError(
        "image",
        "set either image (OCI ref) or command (e.g. 'npx')",
      );
    }

    let image: string | null = null;
    let command: string | null = null;
    let args: string[] = [];

    if (rawImage) {
      if (rawImage.length > 512) {
        throw new ValidationError("image", "must be 512 chars or fewer");
      }
      image = rawImage;
    } else {
      if (!COMMAND_RE.test(rawCommand)) {
        throw new ValidationError(
          "command",
          "must be 1-64 chars, letters/digits/underscore/hyphen/dot/slash only",
        );
      }
      command = rawCommand;
      const rawArgs = input.args ?? [];
      if (!Array.isArray(rawArgs) || !rawArgs.every((a) => typeof a === "string")) {
        throw new ValidationError("args", "must be an array of strings");
      }
      if (rawArgs.length > 32) {
        throw new ValidationError("args", "must be 32 entries or fewer");
      }
      for (const a of rawArgs) {
        if (a.length > 256) {
          throw new ValidationError("args", "each entry must be 256 chars or fewer");
        }
      }
      args = rawArgs;
    }

    return this.repo.upsert({
      workspaceId: input.workspaceId,
      name: input.name,
      displayName: input.displayName,
      kind: "stdio",
      image,
      command,
      args,
      url: null,
      oauthAuthorizationServer: null,
      manifest: input.manifest,
      description: input.description ?? "",
      createdBy: input.createdBy,
    });
  }

  private async setRemoteOAuth(input: {
    workspaceId: string;
    name: ReturnType<typeof CatalogName>;
    displayName: string | null;
    url?: string | null;
    manifest: ReturnType<typeof validateManifest>;
    description?: string;
    createdBy: string | null;
  }): Promise<CatalogEntry> {
    if (!this.remoteOAuth) {
      throw new ValidationError(
        "kind",
        "remote_oauth shape requires the OAuth-enabled CatalogService — wire RemoteOAuthDeps in composition",
      );
    }
    const rawUrl =
      typeof input.url === "string" ? input.url.trim() : "";
    if (rawUrl.length === 0) {
      throw new ValidationError("url", "remote_oauth requires a url");
    }

    // 1. Discover. Validates URL format, fetches RFC 9728 + RFC 8414
    // metadata, ensures DCR + PKCE S256 are supported.
    const discover = this.remoteOAuth.discover ?? discoverMcpServer;
    const discovery = await discover(rawUrl);

    // 2. DCR. Need the workspace slug to construct the redirect URI.
    const slug = await this.remoteOAuth.workspaceSlugFor(input.workspaceId);
    if (!slug) {
      throw new ValidationError(
        "workspaceId",
        "workspace not found for OAuth registration",
      );
    }
    const redirectUri = this.remoteOAuth.redirectUriFor({
      workspaceSlug: slug,
      catalogName: input.name as unknown as string,
    });
    const register =
      this.remoteOAuth.registerClient ?? registerOAuthClient;
    const registered = await register({
      authorizationServer: discovery.authorizationServer,
      redirectUri,
      clientName: `x1agent / ${slug} / ${input.name as unknown as string}`,
    });

    // 3. Persist the catalog entry first so we have an id for the
    // oauth_clients FK. Encrypt the DCR client_secret with the same
    // master key the workspace_secrets store uses.
    const entry = await this.repo.upsert({
      workspaceId: input.workspaceId,
      name: input.name,
      displayName: input.displayName,
      kind: "remote_oauth",
      image: null,
      command: null,
      args: [],
      url: discovery.resource.resource ?? rawUrl,
      oauthAuthorizationServer:
        discovery.authorizationServer as unknown,
      manifest: input.manifest,
      description: input.description ?? "",
      createdBy: input.createdBy,
    });

    const blob = encrypt(registered.clientSecret, this.remoteOAuth.cipherKey);
    await this.remoteOAuth.oauthClients.upsert({
      catalogEntryId: entry.id,
      clientId: registered.clientId,
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      authTag: blob.authTag,
    });

    return entry;
  }

  delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.delete(workspaceId, id);
  }
}
