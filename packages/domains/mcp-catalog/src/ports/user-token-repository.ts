import type { UserMcpToken } from "../domain/user-token.js";

export interface EncryptedTokenBlob {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
}

export interface EncryptedUserTokenInput {
  userId: string;
  catalogEntryId: string;
  accessToken: EncryptedTokenBlob;
  /** May be null for servers that don't return a refresh token. */
  refreshToken: EncryptedTokenBlob | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
}

export interface DecryptedUserTokenBlob {
  userId: string;
  catalogEntryId: string;
  accessToken: EncryptedTokenBlob;
  refreshToken: EncryptedTokenBlob | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
  metadata: UserMcpToken;
}

export interface UserTokenRepository {
  upsert(input: EncryptedUserTokenInput): Promise<UserMcpToken>;
  /** Public projection for the UI — no token bytes leak here. */
  listForUser(userId: string): Promise<UserMcpToken[]>;
  /** Internal — used by the api at session-launch and by refresh. */
  getEncrypted(
    userId: string,
    catalogEntryId: string,
  ): Promise<DecryptedUserTokenBlob | null>;
  delete(userId: string, catalogEntryId: string): Promise<boolean>;
}
