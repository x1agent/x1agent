import type {
  EncryptedToken,
  UserOAuthTokenRow,
} from "../domain/oauth-grant.js";

/**
 * Per-user OAuth token store, keyed on (user_id, provider_id).
 *
 * The store deals only in encrypted blobs — encryption happens at the
 * application boundary (the service that takes plaintext + master key
 * and produces EncryptedToken). The adapter never sees plaintext.
 *
 * One row per user per provider. Upserting overwrites; the row's id is
 * stable across upserts so audit / FKs (none yet) line up.
 *
 * v1 assumes one Google account per x1agent user (one Microsoft, etc.).
 * Multi-account-per-user adds an `accountId` to the key — non-breaking
 * additive evolution.
 */
export interface UserOAuthTokenStore {
  /**
   * Insert or replace a token row. Provider must match an
   * AuthProvider.id ("google", "microsoft-365", …). Refresh token is
   * optional — pass null when the provider didn't issue one on this
   * exchange.
   */
  upsert(input: EncryptedUserOAuthTokenInput): Promise<UserOAuthTokenRow>;

  /**
   * Look up the metadata row by (userId, providerId). Returns null
   * when no such row exists. Plaintext is NEVER part of metadata —
   * use `loadEncryptedTokens` when the application needs to decrypt.
   */
  findByUserAndProvider(
    userId: string,
    providerId: string,
  ): Promise<UserOAuthTokenRow | null>;

  /**
   * Load the encrypted blobs for a (userId, providerId). Caller passes
   * the result through the cipher boundary to recover plaintext for a
   * single outbound API call. Returns null when no row exists.
   */
  loadEncryptedTokens(
    userId: string,
    providerId: string,
  ): Promise<EncryptedUserOAuthTokenBlob | null>;

  /**
   * Replace just the access-token blob + expiry. Used after a refresh
   * round-trip — we got a new access token but the refresh token is
   * unchanged. Avoids re-encrypting / re-writing the refresh blob.
   */
  updateAccessToken(
    userId: string,
    providerId: string,
    accessToken: EncryptedToken,
    expiresAt: Date | null,
  ): Promise<void>;

  /** Hard delete; CASCADE on user delete handles the user-side path. */
  delete(userId: string, providerId: string): Promise<boolean>;
}

export interface EncryptedUserOAuthTokenInput {
  userId: string;
  providerId: string;
  accessToken: EncryptedToken;
  refreshToken: EncryptedToken | null;
  scopesGranted: readonly string[];
  expiresAt: Date | null;
}

export interface EncryptedUserOAuthTokenBlob {
  accessToken: EncryptedToken;
  refreshToken: EncryptedToken | null;
  scopesGranted: readonly string[];
  expiresAt: Date | null;
}
