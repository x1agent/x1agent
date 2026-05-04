import type postgres from "postgres";
import type {
  EncryptedOAuthClientBlob,
  OAuthClientRepository,
  TokenEndpointAuthMethod,
} from "../../ports/oauth-client-repository.js";

interface OAuthClientRow {
  catalog_entry_id: string;
  client_id: string;
  client_secret_ciphertext: Uint8Array;
  client_secret_nonce: Uint8Array;
  client_secret_auth_tag: Uint8Array;
  token_endpoint_auth_method: string;
}

function parseAuthMethod(raw: string): TokenEndpointAuthMethod {
  // Migrations default to client_secret_basic; anything else we wrote
  // ourselves matches the union exactly. Defensive cast for old rows.
  return raw === "client_secret_post"
    ? "client_secret_post"
    : "client_secret_basic";
}

export class PostgresOAuthClientRepository implements OAuthClientRepository {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async upsert(input: EncryptedOAuthClientBlob): Promise<void> {
    await this.sql`
      INSERT INTO mcp_oauth_clients
        (catalog_entry_id, client_id,
         client_secret_ciphertext, client_secret_nonce, client_secret_auth_tag,
         token_endpoint_auth_method)
      VALUES (
        ${input.catalogEntryId},
        ${input.clientId},
        ${Buffer.from(input.ciphertext) as unknown as Uint8Array},
        ${Buffer.from(input.nonce) as unknown as Uint8Array},
        ${Buffer.from(input.authTag) as unknown as Uint8Array},
        ${input.tokenEndpointAuthMethod}
      )
      ON CONFLICT (catalog_entry_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
        client_secret_nonce = EXCLUDED.client_secret_nonce,
        client_secret_auth_tag = EXCLUDED.client_secret_auth_tag,
        token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
        registered_at = now()
    `;
  }

  async getBlob(
    catalogEntryId: string,
  ): Promise<EncryptedOAuthClientBlob | null> {
    const [row] = await this.sql<OAuthClientRow[]>`
      SELECT catalog_entry_id, client_id,
             client_secret_ciphertext, client_secret_nonce, client_secret_auth_tag,
             token_endpoint_auth_method
      FROM mcp_oauth_clients
      WHERE catalog_entry_id = ${catalogEntryId}
    `;
    if (!row) return null;
    return {
      catalogEntryId: row.catalog_entry_id,
      clientId: row.client_id,
      tokenEndpointAuthMethod: parseAuthMethod(row.token_endpoint_auth_method),
      ciphertext: new Uint8Array(row.client_secret_ciphertext),
      nonce: new Uint8Array(row.client_secret_nonce),
      authTag: new Uint8Array(row.client_secret_auth_tag),
    };
  }

  async delete(catalogEntryId: string): Promise<void> {
    await this.sql`
      DELETE FROM mcp_oauth_clients WHERE catalog_entry_id = ${catalogEntryId}
    `;
  }
}
