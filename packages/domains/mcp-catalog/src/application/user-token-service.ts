import { ValidationError } from "@x1agent/kernel";
import {
  decrypt,
  encrypt,
  type MasterKey,
} from "@x1agent/domain-workspace-secrets";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import type { UserMcpToken } from "../domain/user-token.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";
import type { OAuthClientRepository } from "../ports/oauth-client-repository.js";
import type { UserTokenRepository } from "../ports/user-token-repository.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
  refreshAccessToken,
  type PkcePair,
} from "./oauth-flow.js";

export interface OAuthFlowState {
  /** Random string echoed in the redirect; the callback validates. */
  state: string;
  /** PKCE verifier — kept secret on our side, sent at code-exchange. */
  codeVerifier: string;
  /** The catalog entry being authorized. */
  catalogEntryId: string;
  /** The user we're authorizing for. Locked at start time so the
   * callback can't be hijacked into another session. */
  userId: string;
  /** Where the start route wants the user redirected after completion. */
  returnTo: string;
}

export interface StartFlowInput {
  workspaceId: string;
  catalogEntryName: string;
  userId: string;
  returnTo: string;
}

export interface StartFlowResult {
  /** Where to redirect the user — the auth server's authorize URL. */
  authorizeUrl: string;
  /** Opaque state the api persists in a cookie/JWT until callback. */
  flowState: OAuthFlowState;
  /** Redirect URI that was sent to the auth server — must match at exchange. */
  redirectUri: string;
}

export interface CompleteFlowInput {
  workspaceId: string;
  catalogEntryName: string;
  userId: string;
  code: string;
  state: string;
  flowState: OAuthFlowState;
}

export interface UserTokenServiceDeps {
  catalog: CatalogRepository;
  oauthClients: OAuthClientRepository;
  userTokens: UserTokenRepository;
  cipherKey: MasterKey;
  /** Build the redirect URI given the workspace-slug + catalog name. */
  redirectUriFor: (input: {
    workspaceSlug: string;
    catalogName: string;
  }) => string;
  workspaceSlugFor: (workspaceId: string) => Promise<string | null>;
}

/**
 * Use-case orchestrator for the per-user OAuth flow.
 *
 *   start    → look up entry + DCR client → mint PKCE + state → return
 *              authorizeUrl + opaque flow state for the route to stash.
 *   complete → verify state matches → exchange code → encrypt + persist
 *              tokens.
 *   resolve  → return a valid access token, refreshing if needed. The
 *              session-launch path in PR 3 calls this just before
 *              writing the K8s Secret.
 *   list     → public projection for the UI (no token bytes).
 */
export class UserTokenService {
  constructor(private readonly deps: UserTokenServiceDeps) {}

  async start(input: StartFlowInput): Promise<StartFlowResult> {
    const entry = await this.lookupRemoteOAuthEntry(
      input.workspaceId,
      input.catalogEntryName,
    );
    const oauthClient = await this.deps.oauthClients.getBlob(entry.id);
    if (!oauthClient) {
      throw new ValidationError(
        "catalog_entry",
        "OAuth client not registered for this catalog entry — try removing and re-creating it",
      );
    }
    const slug = await this.deps.workspaceSlugFor(input.workspaceId);
    if (!slug) {
      throw new ValidationError("workspace", "workspace not found");
    }
    const redirectUri = this.deps.redirectUriFor({
      workspaceSlug: slug,
      catalogName: entry.name as unknown as string,
    });
    const pkce = generatePkce();
    const state = generateState();
    const authorizeUrl = buildAuthorizeUrl({
      authorizationServer: entry.oauthAuthorizationServer as never,
      clientId: oauthClient.clientId,
      redirectUri,
      pkce,
      state,
    });
    const flowState: OAuthFlowState = {
      state,
      codeVerifier: pkce.codeVerifier,
      catalogEntryId: entry.id,
      userId: input.userId,
      returnTo: input.returnTo,
    };
    return { authorizeUrl, flowState, redirectUri };
  }

  async complete(input: CompleteFlowInput): Promise<UserMcpToken> {
    if (input.state !== input.flowState.state) {
      throw new ValidationError("state", "state mismatch");
    }
    if (input.userId !== input.flowState.userId) {
      throw new ValidationError(
        "user",
        "the user signed in now is not the user who started this flow",
      );
    }
    const entry = await this.lookupRemoteOAuthEntry(
      input.workspaceId,
      input.catalogEntryName,
    );
    if (entry.id !== input.flowState.catalogEntryId) {
      throw new ValidationError(
        "catalog_entry",
        "catalog entry mismatch between start and callback",
      );
    }
    const oauthClient = await this.deps.oauthClients.getBlob(entry.id);
    if (!oauthClient) {
      throw new ValidationError(
        "catalog_entry",
        "OAuth client not registered for this catalog entry",
      );
    }
    const clientSecret = decrypt(
      {
        ciphertext: oauthClient.ciphertext,
        nonce: oauthClient.nonce,
        authTag: oauthClient.authTag,
      },
      this.deps.cipherKey,
    );
    const slug = await this.deps.workspaceSlugFor(input.workspaceId);
    if (!slug) {
      throw new ValidationError("workspace", "workspace not found");
    }
    const redirectUri = this.deps.redirectUriFor({
      workspaceSlug: slug,
      catalogName: entry.name as unknown as string,
    });
    const tokens = await exchangeCodeForTokens({
      authorizationServer: entry.oauthAuthorizationServer as never,
      clientId: oauthClient.clientId,
      clientSecret,
      redirectUri,
      code: input.code,
      codeVerifier: input.flowState.codeVerifier,
    });
    return this.persistTokens({
      userId: input.userId,
      catalogEntryId: entry.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresIn: tokens.expires_in ?? null,
      scope: tokens.scope ?? null,
    });
  }

  /** Used at session-launch by PR 3. Refreshes on the way through if needed. */
  async resolveValidAccessToken(input: {
    userId: string;
    workspaceId: string;
    catalogEntryName: string;
  }): Promise<{ accessToken: string; expiresAt: Date | null } | null> {
    const entry = await this.lookupRemoteOAuthEntry(
      input.workspaceId,
      input.catalogEntryName,
    );
    const blob = await this.deps.userTokens.getEncrypted(
      input.userId,
      entry.id,
    );
    if (!blob) return null;
    const accessToken = decrypt(
      {
        ciphertext: blob.accessToken.ciphertext,
        nonce: blob.accessToken.nonce,
        authTag: blob.accessToken.authTag,
      },
      this.deps.cipherKey,
    );
    const stillValid =
      blob.accessTokenExpiresAt === null ||
      blob.accessTokenExpiresAt.getTime() > Date.now() + 30_000;
    if (stillValid) {
      return { accessToken, expiresAt: blob.accessTokenExpiresAt };
    }
    if (!blob.refreshToken) {
      // Token expired and we have no refresh — caller asks the user
      // to reconnect.
      return null;
    }
    const refreshToken = decrypt(
      {
        ciphertext: blob.refreshToken.ciphertext,
        nonce: blob.refreshToken.nonce,
        authTag: blob.refreshToken.authTag,
      },
      this.deps.cipherKey,
    );
    const oauthClient = await this.deps.oauthClients.getBlob(entry.id);
    if (!oauthClient) return null;
    const clientSecret = decrypt(
      {
        ciphertext: oauthClient.ciphertext,
        nonce: oauthClient.nonce,
        authTag: oauthClient.authTag,
      },
      this.deps.cipherKey,
    );
    try {
      const refreshed = await refreshAccessToken({
        authorizationServer: entry.oauthAuthorizationServer as never,
        clientId: oauthClient.clientId,
        clientSecret,
        refreshToken,
      });
      const persisted = await this.persistTokens({
        userId: input.userId,
        catalogEntryId: entry.id,
        accessToken: refreshed.access_token,
        // Some providers rotate the refresh token; persist the new
        // one when present, otherwise keep the old one.
        refreshToken: refreshed.refresh_token ?? refreshToken,
        expiresIn: refreshed.expires_in ?? null,
        scope: refreshed.scope ?? blob.scope,
      });
      return {
        accessToken: refreshed.access_token,
        expiresAt: persisted.accessTokenExpiresAt,
      };
    } catch {
      // Refresh failed — likely revoked. Force the user to reconnect.
      return null;
    }
  }

  list(userId: string): Promise<UserMcpToken[]> {
    return this.deps.userTokens.listForUser(userId);
  }

  delete(userId: string, catalogEntryId: string): Promise<boolean> {
    return this.deps.userTokens.delete(userId, catalogEntryId);
  }

  // ── helpers ──────────────────────────────────────────────────────

  private async lookupRemoteOAuthEntry(
    workspaceId: string,
    catalogEntryName: string,
  ): Promise<CatalogEntry> {
    const entry = await this.deps.catalog.getByName(
      workspaceId,
      catalogEntryName as never,
    );
    if (!entry) {
      throw new ValidationError("catalog_entry", "catalog entry not found");
    }
    if (entry.kind !== "remote_oauth") {
      throw new ValidationError(
        "catalog_entry",
        "this catalog entry is not a remote_oauth shape — connect not applicable",
      );
    }
    if (!entry.oauthAuthorizationServer) {
      throw new ValidationError(
        "catalog_entry",
        "missing cached OAuth metadata — try re-registering the entry",
      );
    }
    return entry;
  }

  private async persistTokens(input: {
    userId: string;
    catalogEntryId: string;
    accessToken: string;
    refreshToken: string | null;
    expiresIn: number | null;
    scope: string | null;
  }): Promise<UserMcpToken> {
    const accessBlob = encrypt(input.accessToken, this.deps.cipherKey);
    const refreshBlob = input.refreshToken
      ? encrypt(input.refreshToken, this.deps.cipherKey)
      : null;
    const expiresAt =
      input.expiresIn !== null
        ? new Date(Date.now() + input.expiresIn * 1000)
        : null;
    return this.deps.userTokens.upsert({
      userId: input.userId,
      catalogEntryId: input.catalogEntryId,
      accessToken: accessBlob,
      refreshToken: refreshBlob,
      accessTokenExpiresAt: expiresAt,
      scope: input.scope,
    });
  }
}
