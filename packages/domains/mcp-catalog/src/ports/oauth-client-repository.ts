/**
 * Per-catalog-entry OAuth client credentials issued via DCR.
 *
 * Distinct from per-user OAuth tokens (those land in a separate table
 * in the next slice). The values here are workspace-internal — the
 * operator never sees the client_secret, and there's exactly one row
 * per `remote_oauth` catalog entry.
 *
 * client_secret is encrypted at rest with the same AES-256-GCM cipher
 * the workspace_secrets store uses (one master key, two callers).
 */
/** RFC 6749 §2.3.1 — how the client authenticates at the token endpoint.
 * Negotiated at DCR time and stored alongside the client_id so the same
 * scheme is used at every code-exchange / refresh. */
export type TokenEndpointAuthMethod =
  | "client_secret_basic"
  | "client_secret_post";

export interface OAuthClientRecord {
  catalogEntryId: string;
  clientId: string;
  /** Plaintext, only available after decrypt; never persisted. */
  clientSecret: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  registeredAt: Date;
}

export interface EncryptedOAuthClientBlob {
  catalogEntryId: string;
  clientId: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
}

export interface OAuthClientRepository {
  upsert(input: EncryptedOAuthClientBlob): Promise<void>;
  /** Returns null when no client has been registered for this entry yet. */
  getBlob(catalogEntryId: string): Promise<EncryptedOAuthClientBlob | null>;
  delete(catalogEntryId: string): Promise<void>;
}
