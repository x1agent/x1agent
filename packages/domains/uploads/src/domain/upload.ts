import { ValidationError } from "@x1agent/kernel";
import type { UserId } from "@x1agent/kernel";

declare const uploadIdBrand: unique symbol;
export type UploadId = string & { readonly [uploadIdBrand]: true };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse + brand a string into an UploadId. Rejects anything that isn't
 * a well-formed UUID so the id parameter cannot be smuggled into a
 * storage_key as a path-traversal payload.
 */
export const UploadId = (raw: string): UploadId => {
  if (!UUID_RE.test(raw)) {
    throw new ValidationError("upload_id", "must be a UUID");
  }
  return raw.toLowerCase() as UploadId;
};

export type UploadStatus =
  | "pending"
  | "ready"
  | "attached"
  | "expired"
  | "deleted";

export interface Upload {
  id: UploadId;
  userId: UserId;
  sessionId: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  status: UploadStatus;
  createdAt: Date;
  expiresAt: Date;
  attachedAt: Date | null;
}

// Pre-compiled regex for stripping ASCII control chars (0x00–0x1F and 0x7F).
// Authored with explicit char codes so the source file stays free of
// literal control bytes.
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  "g",
);

/**
 * Sanitize a client-supplied filename for storage + display. Strips
 * path separators, control chars, null bytes; caps length at 255.
 * Empty-after-sanitization falls back to `upload.<ext>` derived from
 * the MIME hint (caller supplies the extension).
 *
 * NOT used as a storage_key (that's `uploads/YYYY/MM/DD/<id>.<ext>`).
 * Solely for the agent-container filename + UI display.
 */
export function sanitizeFilename(
  raw: string,
  fallbackExt: string,
): string {
  const cleaned = raw
    .replace(CONTROL_CHARS_RE, "")
    .replace(/[/\\]/g, "")
    .trim()
    .slice(0, 255);
  if (cleaned.length === 0) return `upload.${fallbackExt}`;
  return cleaned;
}

/** Compute the storage-key path: uploads/YYYY/MM/DD/<id>.<ext>, UTC. */
export function buildStorageKey(
  id: UploadId,
  ext: string,
  now: Date,
): string {
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `uploads/${y}/${m}/${d}/${id}.${ext}`;
}
