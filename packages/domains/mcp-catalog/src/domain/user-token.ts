/**
 * Per-user OAuth tokens for a remote_oauth MCP catalog entry.
 *
 * Plaintext is never on the entity. Decryption happens inside the
 * UserTokenService via the workspace_secrets cipher (master key
 * shared across the deployment).
 */
export interface UserMcpToken {
  id: string;
  userId: string;
  catalogEntryId: string;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
  hasRefreshToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserMcpTokenPlain {
  userId: string;
  catalogEntryId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
}
