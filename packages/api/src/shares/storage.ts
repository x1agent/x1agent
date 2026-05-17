import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

/**
 * Share storage. Two paths:
 *
 *   1. GCS (durable) — when `gcsArtifactsBucket` is non-empty. Objects
 *      live under `shares/{share_id}/{rel_path}` — flat, no session id
 *      in the key, so a resumed session that re-shares with the same
 *      share_id overwrites in place rather than forking a parallel
 *      object tree under a different session.
 *
 *   2. Local disk (ephemeral) — fallback for `mise run dev`. Same
 *      flat layout under `X1_SHARES_DIR || /tmp/x1-shares`. Pod-local
 *      tmpfs; wiped on every api restart. Not safe for any cluster
 *      you care about. Operators on GCP get the bucket wired from
 *      terraform + the chart.
 *
 * The local-disk path used to be keyed by session_id; flattening
 * happened with the GCS migration so the two paths agree. The old
 * session-keyed layout is unrecoverable across api restarts anyway, so
 * the local rename has no migration cost.
 */

export const sharesDir = (): string =>
  process.env.X1_SHARES_DIR || "/tmp/x1-shares";

export interface ShareFilePayload {
  path: string;
  content: string;
}

function safeJoin(root: string, rel: string): string | null {
  if (!rel) return null;
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

function gcsObjectName(shareId: string, filePath: string): string {
  return `shares/${shareId}/${filePath}`;
}

/**
 * Write share files to whichever backend is active. Returns total
 * bytes written. When `gcsArtifactsBucket` is set, uploads each file
 * in parallel to GCS; otherwise writes to the local disk fallback.
 *
 * The api uses this on the legacy local-dev path (sidecar without
 * GCS env falls back to `upload_to_api`, which lands here). On a
 * production install both branches end up in GCS — sidecars with
 * the env upload direct, sidecars without route through this hop —
 * so the bytes are durable either way.
 */
export async function writeShareFiles(
  shareId: string,
  files: readonly ShareFilePayload[],
  opts: { gcsArtifactsBucket?: string } = {},
): Promise<number> {
  if (opts.gcsArtifactsBucket) {
    return uploadShareToGcs(opts.gcsArtifactsBucket, shareId, files);
  }
  const root = resolve(sharesDir(), "shares", shareId);
  mkdirSync(root, { recursive: true });
  let total = 0;
  for (const file of files) {
    const full = safeJoin(root, file.path);
    if (!full) continue;
    mkdirSync(dirname(full), { recursive: true });
    const buf = Buffer.from(file.content, "base64");
    writeFileSync(full, buf);
    total += buf.length;
  }
  return total;
}

export function readShareFile(
  shareId: string,
  filePath: string,
): Buffer | null {
  const root = resolve(sharesDir(), "shares", shareId);
  const full = safeJoin(root, filePath);
  if (!full || !existsSync(full)) return null;
  return readFileSync(full);
}

/**
 * Mint a short-lived OAuth token from the GCE metadata server. The
 * api pod's WI'd GSA needs `roles/storage.objectAdmin` on the bucket.
 * Returns null on any failure — caller decides whether that's a 5xx
 * or a graceful fallback.
 */
async function fetchGcsAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );
    const body = (await res.json()) as { access_token?: string };
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

async function uploadShareToGcs(
  bucket: string,
  shareId: string,
  files: readonly ShareFilePayload[],
): Promise<number> {
  const token = await fetchGcsAccessToken();
  if (!token) {
    const err = new Error("gcs_auth_failed");
    (err as Error & { code: string }).code = "gcs_auth_failed";
    throw err;
  }

  let total = 0;
  const uploads = files.map(async (file) => {
    const objectName = gcsObjectName(shareId, file.path);
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
      `?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const buf = Buffer.from(file.content, "base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(buf),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gcs_upload_failed (${res.status}): ${body.slice(0, 200)}`);
    }
    total += buf.length;
  });
  await Promise.all(uploads);
  return total;
}

/**
 * Read a single share file from GCS as a Buffer. Returns null on 404
 * (file genuinely doesn't exist); throws on auth / network failure so
 * the caller can distinguish "no such share" from "GCS hiccup."
 */
export async function downloadShareFromGcs(
  bucket: string,
  shareId: string,
  filePath: string,
): Promise<Buffer | null> {
  const token = await fetchGcsAccessToken();
  if (!token) {
    const err = new Error("gcs_auth_failed");
    (err as Error & { code: string }).code = "gcs_auth_failed";
    throw err;
  }
  const objectName = gcsObjectName(shareId, filePath);
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`gcs_fetch_failed (${res.status})`);
    (err as Error & { code: string }).code = "gcs_fetch_failed";
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Per-session staging area for X1A-63 (`share_to_child`). Each stage
 * has its own id under the child's directory so a re-stage at the
 * same dest_path doesn't clobber a previous transfer mid-fetch.
 *
 * Layout:
 *   sessions/{child_session_id}/staging/{stage_id}/{rel_path...}
 *
 * Staging remains local-disk-only. Transfers are short-lived (the
 * child fetches and the api cleans up); the api restart durability
 * problem doesn't apply.
 */
export const stagingDir = (): string =>
  process.env.X1_STAGING_DIR || sharesDir();

export function writeStagingFiles(
  childSessionId: string,
  stageId: string,
  files: readonly ShareFilePayload[],
): { totalSize: number; paths: string[] } {
  const root = resolve(
    stagingDir(),
    "sessions",
    childSessionId,
    "staging",
    stageId,
  );
  mkdirSync(root, { recursive: true });
  let totalSize = 0;
  const paths: string[] = [];
  for (const file of files) {
    const full = safeJoin(root, file.path);
    if (!full) continue;
    mkdirSync(dirname(full), { recursive: true });
    const buf = Buffer.from(file.content, "base64");
    writeFileSync(full, buf);
    totalSize += buf.length;
    paths.push(file.path);
  }
  return { totalSize, paths };
}

export function readStagingFile(
  childSessionId: string,
  stageId: string,
  filePath: string,
): Buffer | null {
  const root = resolve(
    stagingDir(),
    "sessions",
    childSessionId,
    "staging",
    stageId,
  );
  const full = safeJoin(root, filePath);
  if (!full || !existsSync(full)) return null;
  return readFileSync(full);
}

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  jsonl: "application/jsonl",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  ts: "text/typescript",
  tsx: "text/typescript",
  py: "text/x-python",
  rs: "text/x-rust",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/toml",
  sh: "text/x-shellscript",
  xml: "text/xml",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function getMimeType(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
