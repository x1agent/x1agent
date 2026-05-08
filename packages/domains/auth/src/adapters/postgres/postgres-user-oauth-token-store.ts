import type postgres from "postgres";
import type { EncryptedToken, UserOAuthTokenRow } from "../../domain/oauth-grant.js";
import type {
  EncryptedUserOAuthTokenBlob,
  EncryptedUserOAuthTokenInput,
  UserOAuthTokenStore,
} from "../../ports/user-oauth-token-store.js";

interface MetaRow {
  id: string;
  user_id: string;
  provider: string;
  scopes_granted: string[];
  expires_at: Date | null;
  has_refresh: boolean;
  created_at: Date;
  updated_at: Date;
}

interface BlobRow {
  access_token_ciphertext: Uint8Array;
  access_token_nonce: Uint8Array;
  access_token_auth_tag: Uint8Array;
  refresh_token_ciphertext: Uint8Array | null;
  refresh_token_nonce: Uint8Array | null;
  refresh_token_auth_tag: Uint8Array | null;
  scopes_granted: string[];
  expires_at: Date | null;
}

function rowToMeta(row: MetaRow): UserOAuthTokenRow {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider,
    scopesGranted: row.scopes_granted,
    expiresAt: row.expires_at,
    hasRefreshToken: row.has_refresh,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bufFrom(bytes: Uint8Array): Uint8Array {
  // postgres-js wants real Buffers for BYTEA columns; the cipher
  // returns plain Uint8Array. Coerce at the boundary.
  return Buffer.from(bytes) as unknown as Uint8Array;
}

export class PostgresUserOAuthTokenStore implements UserOAuthTokenStore {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async upsert(
    input: EncryptedUserOAuthTokenInput,
  ): Promise<UserOAuthTokenRow> {
    const refreshCipher = input.refreshToken?.ciphertext ?? null;
    const refreshNonce = input.refreshToken?.nonce ?? null;
    const refreshTag = input.refreshToken?.authTag ?? null;

    const [row] = await this.sql<MetaRow[]>`
      INSERT INTO user_oauth_tokens
        (user_id, provider,
         access_token_ciphertext, access_token_nonce, access_token_auth_tag,
         refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
         scopes_granted, expires_at)
      VALUES (
        ${input.userId},
        ${input.providerId},
        ${bufFrom(input.accessToken.ciphertext)},
        ${bufFrom(input.accessToken.nonce)},
        ${bufFrom(input.accessToken.authTag)},
        ${refreshCipher ? bufFrom(refreshCipher) : null},
        ${refreshNonce ? bufFrom(refreshNonce) : null},
        ${refreshTag ? bufFrom(refreshTag) : null},
        ${this.sql.array(input.scopesGranted as string[])},
        ${input.expiresAt}
      )
      ON CONFLICT (user_id, provider) DO UPDATE SET
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        access_token_nonce = EXCLUDED.access_token_nonce,
        access_token_auth_tag = EXCLUDED.access_token_auth_tag,
        -- Preserve a previously-stored refresh token when the new
        -- exchange didn't include one. Google omits refresh_token on
        -- subsequent consents unless prompt=consent forces it; losing
        -- the stored refresh on every login would break offline access.
        refresh_token_ciphertext = COALESCE(EXCLUDED.refresh_token_ciphertext, user_oauth_tokens.refresh_token_ciphertext),
        refresh_token_nonce = COALESCE(EXCLUDED.refresh_token_nonce, user_oauth_tokens.refresh_token_nonce),
        refresh_token_auth_tag = COALESCE(EXCLUDED.refresh_token_auth_tag, user_oauth_tokens.refresh_token_auth_tag),
        scopes_granted = EXCLUDED.scopes_granted,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
      RETURNING id, user_id, provider, scopes_granted, expires_at,
                (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
                created_at, updated_at
    `;
    if (!row) throw new Error("upsert returned no row");
    return rowToMeta(row);
  }

  async findByUserAndProvider(
    userId: string,
    providerId: string,
  ): Promise<UserOAuthTokenRow | null> {
    const rows = await this.sql<MetaRow[]>`
      SELECT id, user_id, provider, scopes_granted, expires_at,
             (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
             created_at, updated_at
      FROM user_oauth_tokens
      WHERE user_id = ${userId} AND provider = ${providerId}
    `;
    return rows[0] ? rowToMeta(rows[0]) : null;
  }

  async loadEncryptedTokens(
    userId: string,
    providerId: string,
  ): Promise<EncryptedUserOAuthTokenBlob | null> {
    const rows = await this.sql<BlobRow[]>`
      SELECT access_token_ciphertext, access_token_nonce, access_token_auth_tag,
             refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
             scopes_granted, expires_at
      FROM user_oauth_tokens
      WHERE user_id = ${userId} AND provider = ${providerId}
    `;
    const row = rows[0];
    if (!row) return null;

    const accessToken: EncryptedToken = {
      ciphertext: row.access_token_ciphertext,
      nonce: row.access_token_nonce,
      authTag: row.access_token_auth_tag,
    };

    const refreshToken: EncryptedToken | null =
      row.refresh_token_ciphertext &&
      row.refresh_token_nonce &&
      row.refresh_token_auth_tag
        ? {
            ciphertext: row.refresh_token_ciphertext,
            nonce: row.refresh_token_nonce,
            authTag: row.refresh_token_auth_tag,
          }
        : null;

    return {
      accessToken,
      refreshToken,
      scopesGranted: row.scopes_granted,
      expiresAt: row.expires_at,
    };
  }

  async updateAccessToken(
    userId: string,
    providerId: string,
    accessToken: EncryptedToken,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.sql`
      UPDATE user_oauth_tokens
      SET access_token_ciphertext = ${bufFrom(accessToken.ciphertext)},
          access_token_nonce = ${bufFrom(accessToken.nonce)},
          access_token_auth_tag = ${bufFrom(accessToken.authTag)},
          expires_at = ${expiresAt},
          updated_at = now()
      WHERE user_id = ${userId} AND provider = ${providerId}
    `;
  }

  async delete(userId: string, providerId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM user_oauth_tokens
      WHERE user_id = ${userId} AND provider = ${providerId}
    `;
    return result.count > 0;
  }
}
