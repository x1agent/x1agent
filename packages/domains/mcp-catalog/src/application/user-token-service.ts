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
  exchangeCodeForTokens as defaultExchangeCodeForTokens,
  generatePkce,
  generateState,
  refreshAccessToken as defaultRefreshAccessToken,
  StaleClientRegistrationError,
  type PkcePair,
} from "./oauth-flow.js";

/**
 * Thrown by `complete()` when the upstream auth server rejected our
 * client credentials at token-exchange time. The route handler is
 * expected to redirect the user back to `/auth/mcp/start/<slug>/<name>`
 * — by the time they re-hit start(), the `mcp_oauth_clients` row is
 * gone (we deleted it) and `resolveOAuthClient` will re-DCR, mint a
 * fresh authorize URL with the new client_id, and the next round-trip
 * succeeds. No operator action required.
 */
export class ClientRegistrationRecoveredError extends Error {
  constructor(public readonly retryStartPath: string) {
    super(
      "stale DCR client_id wiped; user should be redirected to retry the OAuth flow",
    );
    this.name = "ClientRegistrationRecoveredError";
  }
}

export interface OAuthFlowState {
  /** Random string echoed in the redirect; the callback validates. */
  state: string;
  /** PKCE verifier — kept secret on our side, sent at code-exchange. */
  codeVerifier: string;
  /** The catalog entry being authorized. */
  catalogEntryId: string;
  /** The workspace the flow started in. Bound here so the callback
   * route can refuse a cross-workspace replay even if the catalog id
   * happens to collide. */
  workspaceId: string;
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
  /** Optional DCR override for tests; defaults to the live registerOAuthClient. */
  registerClient?: typeof registerOAuthClient;
  /** Optional token-exchange override for tests; defaults to the live
   *  exchangeCodeForTokens. */
  exchangeCodeForTokens?: typeof defaultExchangeCodeForTokens;
  /** Optional refresh override for tests; defaults to the live
   *  refreshAccessToken. */
  refreshAccessToken?: typeof defaultRefreshAccessToken;
  /** Optional server-side logger for upstream error bodies. The
   *  bodies can echo submitted secrets so they NEVER reach the user;
   *  this lets the composition root pipe them to a sink (e.g.
   *  `console.error` or Sentry breadcrumbs) for ops debugging. */
  logUpstreamError?: (info: {
    endpoint: string;
    status: number;
    body: string;
  }) => void;
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
    const slug = await this.deps.workspaceSlugFor(input.workspaceId);
    if (!slug) {
      throw new ValidationError("workspace", "workspace not found");
    }
    const redirectUri = this.deps.redirectUriFor({
      workspaceSlug: slug,
      catalogName: entry.name as unknown as string,
    });
    // Self-heal on a missing oauth_clients row: re-DCR transparently
    // rather than asking the operator to delete the catalog entry.
    // Same helper handles the "complete() wiped the row because
    // upstream rejected the client_id" recovery path.
    const oauthClient = await this.resolveOAuthClient({
      entry,
      workspaceSlug: slug,
      redirectUri,
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
      workspaceId: input.workspaceId,
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
    const slug = await this.deps.workspaceSlugFor(input.workspaceId);
    if (!slug) {
      throw new ValidationError("workspace", "workspace not found");
    }
    const redirectUri = this.deps.redirectUriFor({
      workspaceSlug: slug,
      catalogName: entry.name as unknown as string,
    });
    const oauthClient = await this.resolveOAuthClient({
      entry,
      workspaceSlug: slug,
      redirectUri,
    });
    const clientSecret = decrypt(
      {
        ciphertext: oauthClient.ciphertext,
        nonce: oauthClient.nonce,
        authTag: oauthClient.authTag,
      },
      this.deps.cipherKey,
    );
    const exchange =
      this.deps.exchangeCodeForTokens ?? defaultExchangeCodeForTokens;
    let tokens;
    try {
      tokens = await exchange(
        {
          authorizationServer: entry.oauthAuthorizationServer as never,
          clientId: oauthClient.clientId,
          clientSecret,
          authMethod: oauthClient.tokenEndpointAuthMethod,
          redirectUri,
          code: input.code,
          codeVerifier: input.flowState.codeVerifier,
        },
        { logUpstreamError: this.deps.logUpstreamError },
      );
    } catch (err) {
      if (err instanceof StaleClientRegistrationError) {
        // The DCR client_id we stored is no longer accepted at the
        // upstream token endpoint (RFC 6749 invalid_client /
        // unauthorized_client). Drop the row so the next /start hit
        // re-DCRs through resolveOAuthClient, and signal the route
        // to redirect there. The user sees a single round-trip
        // through the provider's consent screen and that's it —
        // never any "delete from settings, click re-add" surgery.
        await this.deps.oauthClients.delete(entry.id);
        throw new ClientRegistrationRecoveredError(
          `/auth/mcp/start/${slug}/${entry.name as unknown as string}`,
        );
      }
      throw err;
    }
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
    const refresh =
      this.deps.refreshAccessToken ?? defaultRefreshAccessToken;
    try {
      const refreshed = await refresh(
        {
          authorizationServer: entry.oauthAuthorizationServer as never,
          clientId: oauthClient.clientId,
          clientSecret,
          authMethod: oauthClient.tokenEndpointAuthMethod,
          refreshToken,
        },
        { logUpstreamError: this.deps.logUpstreamError },
      );
      // Some providers omit `expires_in` from refresh responses (legal
       // per RFC 6749 §5.1). If we wrote `null` we'd treat the cached
       // access token as never-expiring and ride it past its real death.
       // Default to 1h — short enough that we'll re-refresh well before
       // most providers' real TTLs (which range 1h–24h+).
      const REFRESH_FALLBACK_EXPIRES_IN_S = 3600;
      const persisted = await this.persistTokens({
        userId: input.userId,
        catalogEntryId: entry.id,
        accessToken: refreshed.access_token,
        // Some providers rotate the refresh token; persist the new
        // one when present, otherwise keep the old one.
        refreshToken: refreshed.refresh_token ?? refreshToken,
        expiresIn: refreshed.expires_in ?? REFRESH_FALLBACK_EXPIRES_IN_S,
        scope: refreshed.scope ?? blob.scope,
      });
      return {
        accessToken: refreshed.access_token,
        expiresAt: persisted.accessTokenExpiresAt,
      };
    } catch (err) {
      if (err instanceof StaleClientRegistrationError) {
        // Same recovery shape as `complete()`: the upstream rejected
        // our cached client_id at refresh time. Wipe the row so the
        // user's next interactive Connect re-DCRs through the
        // self-heal path. Return null here — the session-launch
        // caller treats null as "user needs to reconnect", which
        // shows the dim Connect pill rather than crashing.
        await this.deps.oauthClients.delete(entry.id);
        return null;
      }
      // Refresh failed (revoked / network / other). Force the user to
      // reconnect — same null-return signal as the stale-client path.
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

  /**
   * Self-heal helper: return the OAuth client blob for a catalog
   * entry, re-running DCR if the row is missing. The catalog entry
   * caches the auth-server metadata at create time, so DCR is fully
   * replayable from (entry, slug, redirectUri).
   *
   * Two callers trigger the missing-row path:
   *   1. A first-ever Connect after the catalog row was inserted but
   *      the mcp_oauth_clients write failed (the May 3 Mercury orphan
   *      pattern — non-transactional create flow).
   *   2. complete() wiped the row because the upstream returned
   *      invalid_client / unauthorized_client at token exchange,
   *      and the route bounced the user back to /start to recover.
   *
   * Both arrive here with `getBlob() == null` and we re-DCR
   * transparently. The previous explicit "OAuth client not
   * registered — try removing and re-creating it" error required
   * the operator to surgically delete the catalog entry; this helper
   * makes that unnecessary.
   */
  private async resolveOAuthClient(input: {
    entry: CatalogEntry;
    workspaceSlug: string;
    redirectUri: string;
  }) {
    const existing = await this.deps.oauthClients.getBlob(input.entry.id);
    if (existing) return existing;
    const register = this.deps.registerClient ?? registerOAuthClient;
    const registered = await register({
      authorizationServer: input.entry.oauthAuthorizationServer as never,
      redirectUri: input.redirectUri,
      clientName: `x1agent / ${input.workspaceSlug}`,
    });
    const blob = encrypt(registered.clientSecret, this.deps.cipherKey);
    await this.deps.oauthClients.upsert({
      catalogEntryId: input.entry.id,
      clientId: registered.clientId,
      tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod,
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      authTag: blob.authTag,
    });
    return {
      catalogEntryId: input.entry.id,
      clientId: registered.clientId,
      tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod,
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      authTag: blob.authTag,
    };
  }

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
