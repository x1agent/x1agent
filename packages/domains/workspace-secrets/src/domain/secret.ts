import type { SecretName } from "./secret-name.js";

/**
 * A workspace secret as stored in the repository. Plaintext is NEVER
 * a property on this type — values flow through the cipher boundary
 * only. This is the "metadata" projection used by every API response.
 */
export interface SecretMetadata {
  id: string;
  workspaceId: string;
  name: SecretName;
  isSet: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * Encrypted blob shape held by the repository. Internal — never leaks
 * past the application service.
 */
export interface EncryptedSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
}
