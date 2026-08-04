import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type postgres from "postgres";

type Sql = postgres.Sql<Record<string, unknown>>;

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

export interface OAuthPrincipal {
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

export interface OAuthAuthorizationRequest {
  clientId: string;
  userId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  state: string | null;
}

export interface AdminMcpOAuthStore {
  registerClient(input: {
    clientName: string | null;
    redirectUris: string[];
  }): Promise<OAuthClient>;
  findClient(clientId: string): Promise<OAuthClient | null>;
  createAuthorizationRequest(input: OAuthAuthorizationRequest): Promise<string>;
  consumeAuthorizationRequest(input: {
    token: string;
    userId: string;
  }): Promise<OAuthAuthorizationRequest | null>;
  authorize(input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    resource: string;
    scope: string;
    codeChallenge: string;
  }): Promise<string>;
  exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
  }): Promise<OAuthTokenSet | null>;
  exchangeRefreshToken(input: {
    refreshToken: string;
    clientId: string;
    resource?: string;
    scope?: string;
  }): Promise<OAuthTokenSet | null>;
  verifyAccessToken(
    token: string,
    resource: string,
  ): Promise<OAuthPrincipal | null>;
  revoke(token: string): Promise<void>;
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function normalizeScope(scope: string): string {
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort().join(" ");
}

function isScopeSubset(requested: string, granted: string): boolean {
  const allowed = new Set(granted.split(/\s+/).filter(Boolean));
  return requested
    .split(/\s+/)
    .filter(Boolean)
    .every((scope) => allowed.has(scope));
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
}

interface CodeRow {
  client_id: string;
  user_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  code_challenge: string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

interface AuthorizationRequestRow {
  client_id: string;
  user_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  code_challenge: string;
  state: string | null;
  expires_at: Date | string;
  used_at: Date | string | null;
}

interface TokenRow {
  token_kind: "access" | "refresh";
  family_id: string;
  client_id: string;
  user_id: string;
  resource: string;
  scope: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  replaced_by_hash: string | null;
}

interface PrincipalRow {
  client_id: string;
  user_id: string;
  scope: string;
  expires_at: Date | string;
}

export class PostgresAdminMcpOAuthStore implements AdminMcpOAuthStore {
  private nextCleanupAt = 0;

  constructor(private readonly sql: Sql) {}

  async registerClient(input: {
    clientName: string | null;
    redirectUris: string[];
  }): Promise<OAuthClient> {
    const clientId = `x1mcp_${randomUUID()}`;
    const rows = await this.sql<ClientRow[]>`
      INSERT INTO admin_mcp_oauth_clients (client_id, client_name, redirect_uris)
      VALUES (${clientId}, ${input.clientName}, ${input.redirectUris})
      RETURNING client_id, client_name, redirect_uris
    `;
    this.scheduleCleanup();
    return this.toClient(rows[0]!);
  }

  async findClient(clientId: string): Promise<OAuthClient | null> {
    const rows = await this.sql<ClientRow[]>`
      SELECT client_id, client_name, redirect_uris
      FROM admin_mcp_oauth_clients
      WHERE client_id = ${clientId}
    `;
    return rows[0] ? this.toClient(rows[0]) : null;
  }

  async createAuthorizationRequest(
    input: OAuthAuthorizationRequest,
  ): Promise<string> {
    const token = opaqueToken("x1ar");
    await this.sql.begin(async (tx) => {
      const clients = await tx<{ client_id: string }[]>`
        UPDATE admin_mcp_oauth_clients
        SET last_used_at = now()
        WHERE client_id = ${input.clientId}
        RETURNING client_id
      `;
      if (!clients[0]) throw new Error("OAuth client no longer exists");
      // Keep only the newest pending transaction per user/client pair. This
      // bounds repeated authorization-page loads without weakening one-time
      // consumption; an older open tab simply has to refresh.
      await tx`
        DELETE FROM admin_mcp_oauth_authorization_requests
        WHERE user_id = ${input.userId}
          AND client_id = ${input.clientId}
          AND used_at IS NULL
      `;
      await tx`
        INSERT INTO admin_mcp_oauth_authorization_requests
          (token_hash, client_id, user_id, redirect_uri, resource, scope,
           code_challenge, state, expires_at)
        VALUES
          (${digest(token)}, ${input.clientId}, ${input.userId}, ${input.redirectUri},
           ${input.resource}, ${input.scope}, ${input.codeChallenge}, ${input.state},
           now() + (${AUTHORIZATION_REQUEST_TTL_SECONDS} * interval '1 second'))
      `;
    });
    this.scheduleCleanup();
    return token;
  }

  async consumeAuthorizationRequest(input: {
    token: string;
    userId: string;
  }): Promise<OAuthAuthorizationRequest | null> {
    return (await this.sql.begin(async (tx) => {
      const rows = await tx<AuthorizationRequestRow[]>`
        SELECT client_id, user_id, redirect_uri, resource, scope,
               code_challenge, state, expires_at, used_at
        FROM admin_mcp_oauth_authorization_requests
        WHERE token_hash = ${digest(input.token)}
        FOR UPDATE
      `;
      const row = rows[0];
      if (
        !row ||
        row.user_id !== input.userId ||
        row.used_at ||
        new Date(row.expires_at).getTime() <= Date.now()
      ) {
        return null;
      }
      await tx`
        UPDATE admin_mcp_oauth_authorization_requests
        SET used_at = now()
        WHERE token_hash = ${digest(input.token)}
      `;
      return {
        clientId: row.client_id,
        userId: row.user_id,
        redirectUri: row.redirect_uri,
        resource: row.resource,
        scope: row.scope,
        codeChallenge: row.code_challenge,
        state: row.state,
      };
    })) as OAuthAuthorizationRequest | null;
  }

  async authorize(input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    resource: string;
    scope: string;
    codeChallenge: string;
  }): Promise<string> {
    const code = opaqueToken("x1ac");
    const codeHash = digest(code);
    const scope = normalizeScope(input.scope);
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO admin_mcp_oauth_consents
          (user_id, client_id, resource, scope, granted_at, revoked_at)
        VALUES
          (${input.userId}, ${input.clientId}, ${input.resource}, ${scope}, now(), NULL)
        ON CONFLICT (user_id, client_id, resource) DO UPDATE
        SET scope = EXCLUDED.scope, granted_at = now(), revoked_at = NULL
      `;
      await tx`
        INSERT INTO admin_mcp_oauth_codes
          (code_hash, client_id, user_id, redirect_uri, resource, scope,
           code_challenge, expires_at)
        VALUES
          (${codeHash}, ${input.clientId}, ${input.userId}, ${input.redirectUri},
           ${input.resource}, ${scope}, ${input.codeChallenge},
           now() + (${AUTHORIZATION_CODE_TTL_SECONDS} * interval '1 second'))
      `;
      await tx`
        UPDATE admin_mcp_oauth_clients
        SET last_used_at = now()
        WHERE client_id = ${input.clientId}
      `;
    });
    this.scheduleCleanup();
    return code;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
  }): Promise<OAuthTokenSet | null> {
    this.scheduleCleanup();
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) return null;
    return (await this.sql.begin(async (tx) => {
      const rows = await tx<CodeRow[]>`
        SELECT client_id, user_id, redirect_uri, resource, scope,
               code_challenge, expires_at, used_at
        FROM admin_mcp_oauth_codes
        WHERE code_hash = ${digest(input.code)}
        FOR UPDATE
      `;
      const row = rows[0];
      if (
        !row ||
        row.used_at ||
        new Date(row.expires_at).getTime() <= Date.now()
      ) {
        return null;
      }
      await tx`
        UPDATE admin_mcp_oauth_codes SET used_at = now()
        WHERE code_hash = ${digest(input.code)}
      `;
      if (
        row.client_id !== input.clientId ||
        row.redirect_uri !== input.redirectUri ||
        row.resource !== input.resource ||
        !safeEqual(row.code_challenge, pkceChallenge(input.codeVerifier))
      ) {
        return null;
      }
      return await this.issueTokenPair(tx, {
        clientId: row.client_id,
        userId: row.user_id,
        resource: row.resource,
        scope: row.scope,
        familyId: randomUUID(),
      });
    })) as OAuthTokenSet | null;
  }

  async exchangeRefreshToken(input: {
    refreshToken: string;
    clientId: string;
    resource?: string;
    scope?: string;
  }): Promise<OAuthTokenSet | null> {
    this.scheduleCleanup();
    return (await this.sql.begin(async (tx) => {
      const tokenHash = digest(input.refreshToken);
      const rows = await tx<TokenRow[]>`
        SELECT token_kind, family_id, client_id, user_id, resource, scope,
               expires_at, revoked_at, replaced_by_hash
        FROM admin_mcp_oauth_tokens
        WHERE token_hash = ${tokenHash}
        FOR UPDATE
      `;
      const row = rows[0];
      if (
        !row ||
        row.token_kind !== "refresh" ||
        row.client_id !== input.clientId
      ) {
        return null;
      }
      if (input.resource && input.resource !== row.resource) return null;
      const requestedScope = normalizeScope(input.scope || row.scope);
      if (!isScopeSubset(requestedScope, row.scope)) return null;

      if (
        row.revoked_at ||
        row.replaced_by_hash ||
        new Date(row.expires_at).getTime() <= Date.now()
      ) {
        // A rotated refresh token was presented again. Revoke the entire
        // family so a stolen sibling cannot continue refreshing unnoticed.
        await tx`
          UPDATE admin_mcp_oauth_tokens SET revoked_at = COALESCE(revoked_at, now())
          WHERE family_id = ${row.family_id}
        `;
        return null;
      }

      const nextRefreshToken = opaqueToken("x1rt");
      const nextRefreshHash = digest(nextRefreshToken);
      const accessToken = opaqueToken("x1at");
      await tx`
        UPDATE admin_mcp_oauth_tokens
        SET revoked_at = now(), replaced_by_hash = ${nextRefreshHash}
        WHERE token_hash = ${tokenHash}
      `;
      await this.insertTokenPair(tx, {
        accessToken,
        refreshToken: nextRefreshToken,
        clientId: row.client_id,
        userId: row.user_id,
        resource: row.resource,
        scope: requestedScope,
        familyId: row.family_id,
      });
      return {
        accessToken,
        refreshToken: nextRefreshToken,
        tokenType: "Bearer" as const,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        scope: requestedScope,
      };
    })) as OAuthTokenSet | null;
  }

  async verifyAccessToken(
    token: string,
    resource: string,
  ): Promise<OAuthPrincipal | null> {
    const rows = await this.sql<PrincipalRow[]>`
      SELECT t.client_id, t.user_id, t.scope, t.expires_at
      FROM admin_mcp_oauth_tokens t
      JOIN users u ON u.id = t.user_id
      JOIN admin_mcp_oauth_consents c
        ON c.user_id = t.user_id
       AND c.client_id = t.client_id
       AND c.resource = t.resource
      WHERE t.token_hash = ${digest(token)}
        AND t.token_kind = 'access'
        AND t.resource = ${resource}
        AND t.revoked_at IS NULL
        AND t.expires_at > now()
        AND c.revoked_at IS NULL
        AND u.is_active = true
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      clientId: row.client_id,
      scopes: row.scope.split(/\s+/).filter(Boolean),
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    };
  }

  async revoke(token: string): Promise<void> {
    this.scheduleCleanup();
    await this.sql`
      UPDATE admin_mcp_oauth_tokens
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE family_id = (
        SELECT family_id FROM admin_mcp_oauth_tokens
        WHERE token_hash = ${digest(token)}
      )
    `;
  }

  private scheduleCleanup(): void {
    void this.cleanupIfDue().catch((error) => {
      console.warn("[admin-mcp] OAuth artifact cleanup failed", error);
    });
  }

  /** Opportunistic bounded GC, scheduled by OAuth mutation paths. */
  private async cleanupIfDue(): Promise<void> {
    const now = Date.now();
    if (now < this.nextCleanupAt) return;
    this.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
    try {
      await this.sql.begin(async (tx) => {
        await tx`
          WITH doomed AS (
            SELECT token_hash FROM admin_mcp_oauth_authorization_requests
            WHERE expires_at < now() - interval '1 day'
               OR used_at < now() - interval '1 day'
            ORDER BY expires_at ASC LIMIT 500
          )
          DELETE FROM admin_mcp_oauth_authorization_requests r
          USING doomed d WHERE r.token_hash = d.token_hash
        `;
        await tx`
          WITH doomed AS (
            SELECT code_hash FROM admin_mcp_oauth_codes
            WHERE expires_at < now() - interval '1 day'
               OR used_at < now() - interval '1 day'
            ORDER BY expires_at ASC LIMIT 500
          )
          DELETE FROM admin_mcp_oauth_codes c
          USING doomed d WHERE c.code_hash = d.code_hash
        `;
        await tx`
          WITH doomed AS (
            SELECT family_id
            FROM admin_mcp_oauth_tokens
            GROUP BY family_id
            HAVING bool_and(expires_at < now() OR revoked_at IS NOT NULL)
               AND max(created_at) < now() - interval '7 days'
            ORDER BY max(created_at) ASC LIMIT 200
          )
          DELETE FROM admin_mcp_oauth_tokens t
          USING doomed d WHERE t.family_id = d.family_id
        `;
        await tx`
          WITH doomed AS (
            SELECT client_id FROM admin_mcp_oauth_clients c
            WHERE last_used_at IS NULL
              AND created_at < now() - interval '1 day'
              AND NOT EXISTS (
                SELECT 1 FROM admin_mcp_oauth_authorization_requests r
                WHERE r.client_id = c.client_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM admin_mcp_oauth_codes a
                WHERE a.client_id = c.client_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM admin_mcp_oauth_tokens t
                WHERE t.client_id = c.client_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM admin_mcp_oauth_consents s
                WHERE s.client_id = c.client_id
              )
            ORDER BY created_at ASC LIMIT 100
          )
          DELETE FROM admin_mcp_oauth_clients c
          USING doomed d WHERE c.client_id = d.client_id
        `;
      });
    } catch (error) {
      this.nextCleanupAt = 0;
      throw error;
    }
  }

  private toClient(row: ClientRow): OAuthClient {
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      redirectUris: row.redirect_uris,
    };
  }

  private async issueTokenPair(
    tx: postgres.TransactionSql<Record<string, unknown>>,
    input: {
      clientId: string;
      userId: string;
      resource: string;
      scope: string;
      familyId: string;
    },
  ): Promise<OAuthTokenSet> {
    const accessToken = opaqueToken("x1at");
    const refreshToken = opaqueToken("x1rt");
    await this.insertTokenPair(tx, { ...input, accessToken, refreshToken });
    return {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      scope: input.scope,
    };
  }

  private async insertTokenPair(
    tx: postgres.TransactionSql<Record<string, unknown>>,
    input: {
      accessToken: string;
      refreshToken: string;
      clientId: string;
      userId: string;
      resource: string;
      scope: string;
      familyId: string;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO admin_mcp_oauth_tokens
        (token_hash, token_kind, family_id, client_id, user_id, resource, scope, expires_at)
      VALUES
        (${digest(input.accessToken)}, 'access', ${input.familyId}, ${input.clientId},
         ${input.userId}, ${input.resource}, ${input.scope},
         now() + (${ACCESS_TOKEN_TTL_SECONDS} * interval '1 second')),
        (${digest(input.refreshToken)}, 'refresh', ${input.familyId}, ${input.clientId},
         ${input.userId}, ${input.resource}, ${input.scope},
         now() + (${REFRESH_TOKEN_TTL_SECONDS} * interval '1 second'))
    `;
  }
}
