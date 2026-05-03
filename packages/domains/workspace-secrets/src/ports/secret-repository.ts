import type { EncryptedSecret, SecretMetadata } from "../domain/secret.js";
import type { SecretName } from "../domain/secret-name.js";

/**
 * Persistence port for workspace secrets. Implemented by adapters
 * (Postgres today; potentially K8s Secret in v2). The application
 * service depends on this interface, never on a concrete adapter.
 *
 * The plaintext value never crosses this boundary. The repository
 * stores and returns the encrypted blob. Encryption / decryption
 * happens in the application service so the repository never holds
 * the master key.
 */
export interface SecretRepository {
  list(workspaceId: string): Promise<SecretMetadata[]>;

  /** Returns null if no secret with this name exists in the workspace. */
  getBlob(
    workspaceId: string,
    name: SecretName,
  ): Promise<EncryptedSecret | null>;

  /**
   * Idempotent set — creates a row on first call, updates on subsequent.
   * Returns the resulting metadata. Treats updatedBy as nullable so the
   * platform can write secrets without an attributable user (rare; the
   * UI always passes one).
   */
  upsert(
    workspaceId: string,
    name: SecretName,
    blob: EncryptedSecret,
    updatedBy: string | null,
  ): Promise<SecretMetadata>;

  delete(workspaceId: string, name: SecretName): Promise<boolean>;
}
