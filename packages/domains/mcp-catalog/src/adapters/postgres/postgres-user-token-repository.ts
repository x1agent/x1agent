import type postgres from "postgres";
import type { UserMcpToken } from "../../domain/user-token.js";
import type {
  DecryptedUserTokenBlob,
  EncryptedUserTokenInput,
  UserTokenRepository,
} from "../../ports/user-token-repository.js";

interface MetaRow {
  id: string;
  user_id: string;
  catalog_entry_id: string;
  access_token_expires_at: Date | null;
  scope: string | null;
  has_refresh: boolean;
  created_at: Date;
  updated_at: Date;
}

interface FullRow extends MetaRow {
  access_token_ciphertext: Uint8Array;
  access_token_nonce: Uint8Array;
  access_token_auth_tag: Uint8Array;
  refresh_token_ciphertext: Uint8Array | null;
  refresh_token_nonce: Uint8Array | null;
  refresh_token_auth_tag: Uint8Array | null;
}

function rowToMeta(row: MetaRow): UserMcpToken {
  return {
    id: row.id,
    userId: row.user_id,
    catalogEntryId: row.catalog_entry_id,
    accessTokenExpiresAt: row.access_token_expires_at,
    scope: row.scope,
    hasRefreshToken: row.has_refresh,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresUserTokenRepository implements UserTokenRepository {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async upsert(input: EncryptedUserTokenInput): Promise<UserMcpToken> {
    const refreshCipher = input.refreshToken?.ciphertext ?? null;
    const refreshNonce = input.refreshToken?.nonce ?? null;
    const refreshTag = input.refreshToken?.authTag ?? null;
    const [row] = await this.sql<MetaRow[]>`
      INSERT INTO user_mcp_tokens
        (user_id, catalog_entry_id,
         access_token_ciphertext, access_token_nonce, access_token_auth_tag,
         refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
         access_token_expires_at, scope)
      VALUES (
        ${input.userId},
        ${input.catalogEntryId},
        ${Buffer.from(input.accessToken.ciphertext) as unknown as Uint8Array},
        ${Buffer.from(input.accessToken.nonce) as unknown as Uint8Array},
        ${Buffer.from(input.accessToken.authTag) as unknown as Uint8Array},
        ${refreshCipher ? (Buffer.from(refreshCipher) as unknown as Uint8Array) : null},
        ${refreshNonce ? (Buffer.from(refreshNonce) as unknown as Uint8Array) : null},
        ${refreshTag ? (Buffer.from(refreshTag) as unknown as Uint8Array) : null},
        ${input.accessTokenExpiresAt},
        ${input.scope}
      )
      ON CONFLICT (user_id, catalog_entry_id) DO UPDATE SET
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        access_token_nonce = EXCLUDED.access_token_nonce,
        access_token_auth_tag = EXCLUDED.access_token_auth_tag,
        refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
        refresh_token_nonce = EXCLUDED.refresh_token_nonce,
        refresh_token_auth_tag = EXCLUDED.refresh_token_auth_tag,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        scope = EXCLUDED.scope,
        updated_at = now()
      RETURNING id, user_id, catalog_entry_id, access_token_expires_at,
                scope, (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
                created_at, updated_at
    `;
    if (!row) throw new Error("user_mcp_tokens upsert returned no row");
    return rowToMeta(row);
  }

  async listForUser(userId: string): Promise<UserMcpToken[]> {
    const rows = await this.sql<MetaRow[]>`
      SELECT id, user_id, catalog_entry_id, access_token_expires_at,
             scope,
             (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
             created_at, updated_at
      FROM user_mcp_tokens
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC
    `;
    return rows.map(rowToMeta);
  }

  async getEncrypted(
    userId: string,
    catalogEntryId: string,
  ): Promise<DecryptedUserTokenBlob | null> {
    const [row] = await this.sql<FullRow[]>`
      SELECT id, user_id, catalog_entry_id, access_token_expires_at,
             scope,
             (refresh_token_ciphertext IS NOT NULL) AS has_refresh,
             created_at, updated_at,
             access_token_ciphertext, access_token_nonce, access_token_auth_tag,
             refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag
      FROM user_mcp_tokens
      WHERE user_id = ${userId} AND catalog_entry_id = ${catalogEntryId}
    `;
    if (!row) return null;
    return {
      userId: row.user_id,
      catalogEntryId: row.catalog_entry_id,
      accessToken: {
        ciphertext: new Uint8Array(row.access_token_ciphertext),
        nonce: new Uint8Array(row.access_token_nonce),
        authTag: new Uint8Array(row.access_token_auth_tag),
      },
      refreshToken:
        row.refresh_token_ciphertext &&
        row.refresh_token_nonce &&
        row.refresh_token_auth_tag
          ? {
              ciphertext: new Uint8Array(row.refresh_token_ciphertext),
              nonce: new Uint8Array(row.refresh_token_nonce),
              authTag: new Uint8Array(row.refresh_token_auth_tag),
            }
          : null,
      accessTokenExpiresAt: row.access_token_expires_at,
      scope: row.scope,
      metadata: rowToMeta(row),
    };
  }

  async delete(userId: string, catalogEntryId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM user_mcp_tokens
      WHERE user_id = ${userId} AND catalog_entry_id = ${catalogEntryId}
    `;
    return (result.count ?? 0) > 0;
  }
}
