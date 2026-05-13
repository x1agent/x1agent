/**
 * Configuration for the uploads domain, normalized from env in the
 * composition root. All fields have defaults documented in the ticket
 * + the .env.example file.
 */
export interface UploadsConfig {
  /** Maximum upload size in bytes. Default 10 MB. */
  maxBytes: number;
  /** Allowed MIMEs (advisory at init; authoritative after sniff). */
  allowedMimes: readonly string[];
  /** TTL for pending/ready uploads before cleanup. Default 24h. */
  pendingTtlMs: number;
  /** TTL for attached uploads before cleanup. Default 30d. */
  attachedTtlMs: number;
  /** Per-message attachment cap enforced by the wire-format layer; we
   *  carry it here so the route can also enforce it on init bursts. */
  perMessageMax: number;
  /** init rate limit, requests per minute per user. */
  initPerMinute: number;
  /** Lifetime of the signed local-disk upload URL HMAC (ms). */
  signedUrlTtlMs: number;
}

export const DEFAULT_UPLOADS_CONFIG: UploadsConfig = {
  maxBytes: 10 * 1024 * 1024,
  allowedMimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  pendingTtlMs: 24 * 60 * 60 * 1000,
  attachedTtlMs: 30 * 24 * 60 * 60 * 1000,
  perMessageMax: 4,
  initPerMinute: 60,
  signedUrlTtlMs: 15 * 60 * 1000,
};
