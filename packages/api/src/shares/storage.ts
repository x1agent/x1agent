import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

/**
 * Disk-backed share storage for local dev. In production the sidecar
 * uploads directly to GCS and this path is not exercised — the api
 * never sees the file bytes.
 *
 * Layout (under X1_SHARES_DIR):
 *   sessions/{session_id}/shares/{share_id}/{rel_path...}
 */

export const sharesDir = (): string =>
  process.env.X1_SHARES_DIR || "/tmp/x1-shares";

export interface ShareFilePayload {
  path: string;
  content: string;
}

/**
 * Resolve a user-supplied relative path against a share's root, refusing
 * anything that escapes it. Returns null when the result would leave the
 * share directory (e.g. `../../etc/passwd`).
 */
function safeJoin(root: string, rel: string): string | null {
  if (!rel) return null;
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function writeShareFiles(
  sessionId: string,
  shareId: string,
  files: readonly ShareFilePayload[],
): number {
  const root = resolve(sharesDir(), "sessions", sessionId, "shares", shareId);
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
  sessionId: string,
  shareId: string,
  filePath: string,
): Buffer | null {
  const root = resolve(sharesDir(), "sessions", sessionId, "shares", shareId);
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
