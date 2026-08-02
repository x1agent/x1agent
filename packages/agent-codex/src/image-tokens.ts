// TODO(codex-spike): duplicated verbatim from packages/agent/src/image-tokens.ts
// for v0. Extract into agent-runtime-base in the spike follow-up.
/**
 * X1A-96 image-upload token expansion — extracted from run.ts so it
 * can be unit-tested without booting the agent's HTTP listeners.
 *
 * After the t02/t05 P0 fix the agent container no longer holds the
 * api's master internal token. The sidecar (which IS the trust
 * boundary) exposes a `/uploads/read` credential-proxy route the
 * agent POSTs to with just `{ upload_id }`; the sidecar enforces
 * user_id + session_id + workspace match using its own pod env and
 * returns base64-encoded bytes. The agent decodes and writes to
 * /workspace/.x1/uploads/<id>.<ext> so the LLM's `Read` tool can see
 * the image as visual content blocks.
 *
 * See packages/sidecar/src/uploads.rs for the proxy.
 */
import { mkdir, writeFile } from "node:fs/promises";

export const IMAGE_TOKEN_RE =
  /\[image:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\]/gi;

export const DEFAULT_UPLOADS_DIR = "/workspace/.x1/uploads";

export function extFromMime(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
    "text/html": "html",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/json": "json",
  };
  return map[base] ?? "bin";
}

export interface ResolveOpts {
  sidecarUrl: string;
  uploadsDir?: string;
  fetchImpl?: typeof fetch;
  /** Override for tests so writeFile doesn't touch /workspace. */
  writeFileImpl?: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Override for tests so mkdir doesn't touch /workspace. */
  mkdirImpl?: (
    path: string,
    opts?: { recursive?: boolean },
  ) => Promise<unknown>;
  /** Override for tests so logs don't spam the test runner. */
  logImpl?: (msg: string) => void;
}

/**
 * Fetch the bytes for a single upload through the sidecar's
 * `/uploads/read` proxy and write them to disk under
 * `<uploadsDir>/<id>.<ext>`. Returns the replacement string to splice
 * into the message text — either a "use the Read tool on this path"
 * pointer on success, or `(upload <id>: unavailable|error)` on
 * recoverable failure.
 */
export async function resolveSingleUpload(
  id: string,
  opts: ResolveOpts,
): Promise<string> {
  const dir = opts.uploadsDir ?? DEFAULT_UPLOADS_DIR;
  const fetchFn = opts.fetchImpl ?? fetch;
  const writeFn =
    opts.writeFileImpl ?? ((p: string, b: Uint8Array) => writeFile(p, b));
  const mkdirFn =
    opts.mkdirImpl ??
    ((p: string, mkOpts?: { recursive?: boolean }) => mkdir(p, mkOpts));
  const log = opts.logImpl ?? ((m: string) => console.error(m));

  try {
    await mkdirFn(dir, { recursive: true });
  } catch (err) {
    log(`[agent] could not create ${dir}: ${(err as Error).message}`);
    return `(upload ${id}: error)`;
  }

  try {
    const res = await fetchFn(`${opts.sidecarUrl}/uploads/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_id: id }),
    });
    if (!res.ok) {
      log(`[agent] upload ${id} sidecar fetch failed: ${res.status}`);
      return `(upload ${id}: unavailable)`;
    }
    const body = (await res.json()) as
      | { ok: true; content_b64: string; mime: string; size: number }
      | { ok: false; error?: { code?: string; message?: string } };
    if (!body.ok) {
      log(
        `[agent] upload ${id} sidecar denied: ${body.error?.code ?? "unknown"}`,
      );
      return `(upload ${id}: unavailable)`;
    }
    const buf = Buffer.from(body.content_b64, "base64");
    const ext = extFromMime(body.mime);
    const filePath = `${dir}/${id}.${ext}`;
    await writeFn(filePath, buf);
    log(
      `[agent] resolved upload ${id} → ${filePath} (${buf.byteLength} bytes, ${body.mime})`,
    );
    return `(user attached file: ${filePath} — use the Read tool to view it)`;
  } catch (err) {
    log(`[agent] upload ${id} sidecar fetch threw: ${(err as Error).message}`);
    return `(upload ${id}: error)`;
  }
}

/**
 * Expand every `[image: <uuid>]` token in `text` using
 * `resolveSingleUpload`. Deduplicates ids so the same upload is
 * fetched once even if it appears multiple times in the same message.
 */
export async function resolveImageTokens(
  text: string,
  opts: ResolveOpts,
): Promise<string> {
  IMAGE_TOKEN_RE.lastIndex = 0;
  if (!IMAGE_TOKEN_RE.test(text)) return text;

  const expansions = new Map<string, string>();
  IMAGE_TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(IMAGE_TOKEN_RE)) {
    const id = m[1]!.toLowerCase();
    if (expansions.has(id)) continue;
    expansions.set(id, await resolveSingleUpload(id, opts));
  }

  return text.replace(IMAGE_TOKEN_RE, (_full, idRaw: string) => {
    const replacement = expansions.get(idRaw.toLowerCase());
    return replacement ?? `(upload ${idRaw}: missing)`;
  });
}
