import type postgres from "postgres";
import type {
  EncryptedSecret,
  SecretMetadata,
} from "../../domain/secret.js";
import { SecretName } from "../../domain/secret-name.js";
import type { SecretRepository } from "../../ports/secret-repository.js";

interface MetadataRow {
  id: string;
  workspace_id: string;
  name: string;
  is_set: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
}

interface BlobRow {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
}

function rowToMetadata(row: MetadataRow): SecretMetadata {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: SecretName(row.name),
    isSet: row.is_set,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export class PostgresSecretRepository implements SecretRepository {
  constructor(private readonly sql: postgres.Sql<Record<string, unknown>>) {}

  async list(workspaceId: string): Promise<SecretMetadata[]> {
    const rows = await this.sql<MetadataRow[]>`
      SELECT id, workspace_id, name, is_set, created_at, updated_at, updated_by
      FROM workspace_secrets
      WHERE workspace_id = ${workspaceId}
      ORDER BY name ASC
    `;
    return rows.map(rowToMetadata);
  }

  async getBlob(
    workspaceId: string,
    name: SecretName,
  ): Promise<EncryptedSecret | null> {
    const [row] = await this.sql<BlobRow[]>`
      SELECT ciphertext, nonce, auth_tag
      FROM workspace_secrets
      WHERE workspace_id = ${workspaceId} AND name = ${name as string}
    `;
    if (!row) return null;
    return {
      ciphertext: new Uint8Array(row.ciphertext),
      nonce: new Uint8Array(row.nonce),
      authTag: new Uint8Array(row.auth_tag),
    };
  }

  async upsert(
    workspaceId: string,
    name: SecretName,
    blob: EncryptedSecret,
    updatedBy: string | null,
  ): Promise<SecretMetadata> {
    const [row] = await this.sql<MetadataRow[]>`
      INSERT INTO workspace_secrets
        (workspace_id, name, ciphertext, nonce, auth_tag, is_set, updated_by)
      VALUES (
        ${workspaceId}, ${name as string},
        ${Buffer.from(blob.ciphertext) as unknown as Uint8Array},
        ${Buffer.from(blob.nonce) as unknown as Uint8Array},
        ${Buffer.from(blob.authTag) as unknown as Uint8Array},
        TRUE, ${updatedBy}
      )
      ON CONFLICT (workspace_id, name) DO UPDATE SET
        ciphertext = EXCLUDED.ciphertext,
        nonce = EXCLUDED.nonce,
        auth_tag = EXCLUDED.auth_tag,
        is_set = TRUE,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      RETURNING id, workspace_id, name, is_set, created_at, updated_at, updated_by
    `;
    if (!row) throw new Error("workspace_secrets upsert returned no row");
    return rowToMetadata(row);
  }

  async delete(workspaceId: string, name: SecretName): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM workspace_secrets
      WHERE workspace_id = ${workspaceId} AND name = ${name as string}
    `;
    return (result.count ?? 0) > 0;
  }
}
