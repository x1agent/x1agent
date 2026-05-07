/**
 * `files` domain handlers for the google-workspace provider.
 *
 * Implements the Drive read paths against Google Drive v3:
 *   x1.provider.files.list      → drive/v3/files (with q=)
 *   x1.provider.files.get       → drive/v3/files/{id}
 *   x1.provider.files.download  → drive/v3/files/{id}?alt=media
 *
 * Read-only for v1 — uses the drive.readonly scope. Write paths
 * (upload/move/delete) come later when restricted-scope verification
 * lands in prod; until then the handlers reject with
 * unsupported_operation rather than ship a half-implemented mutation
 * surface.
 *
 * Each handler mints a fresh user OAuth token via the api's internal
 * credential proxy (see credential.ts). Tokens are held in memory for
 * the duration of one outbound Drive call and never persisted.
 */

import { CredentialError, mintGoogleToken } from "./credential.js";

const DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export interface ListFilesRequest {
  user_id: string;
  /** Optional Drive query string (Drive v3 `q` parameter). */
  query?: string;
  /** Max results, defaults to 50, capped at 1000 by Drive itself. */
  page_size?: number;
  /** Comma-separated fields to include — defaults to id+name+mimeType. */
  fields?: string;
}

export interface FileEntry {
  id: string;
  name: string;
  mime_type: string;
  modified_time?: string;
  size?: string;
  web_view_link?: string;
}

export interface ListFilesReply {
  ok: true;
  files: FileEntry[];
  next_page_token?: string;
}

export interface GetFileRequest {
  user_id: string;
  file_id: string;
}

export interface GetFileReply {
  ok: true;
  file: FileEntry;
}

export interface DownloadFileRequest {
  user_id: string;
  file_id: string;
}

export interface DownloadFileReply {
  ok: true;
  /** Base64-encoded bytes. NATS payloads can be binary too — base64 keeps the wire shape JSON-compatible for the rest of the contract. */
  content_base64: string;
  mime_type: string;
  size_bytes: number;
}

export interface ErrorReply {
  ok: false;
  error: {
    code: string;
    message: string;
    /** Forwarded scope name when permission_required, so the UI can prompt re-consent. */
    required_scope?: string;
  };
}

export type FilesReply<T> = T | ErrorReply;

function credentialErrorReply(err: CredentialError): ErrorReply {
  return {
    ok: false,
    error: {
      code: err.kind,
      message: err.message,
      required_scope:
        err.kind === "permission_required" ? DRIVE_READONLY_SCOPE : undefined,
    },
  };
}

function driveErrorReply(status: number, body: string): ErrorReply {
  return {
    ok: false,
    error: {
      code: "drive_api_error",
      message: `drive returned ${status}: ${body.slice(0, 500)}`,
    },
  };
}

export async function handleList(
  req: ListFilesRequest,
): Promise<FilesReply<ListFilesReply>> {
  if (!req.user_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id required" },
    };
  }
  let token: string;
  try {
    const minted = await mintGoogleToken(req.user_id, DRIVE_READONLY_SCOPE);
    token = minted.accessToken;
  } catch (err) {
    if (err instanceof CredentialError) return credentialErrorReply(err);
    throw err;
  }

  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set("pageSize", String(req.page_size ?? 50));
  url.searchParams.set(
    "fields",
    req.fields ?? "files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken",
  );
  if (req.query) url.searchParams.set("q", req.query);

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());

  const body = (await resp.json()) as {
    files?: Array<{
      id?: string;
      name?: string;
      mimeType?: string;
      modifiedTime?: string;
      size?: string;
      webViewLink?: string;
    }>;
    nextPageToken?: string;
  };

  const files: FileEntry[] = (body.files ?? [])
    .filter((f): f is { id: string; name: string; mimeType: string } & typeof f =>
      Boolean(f.id && f.name && f.mimeType),
    )
    .map((f) => ({
      id: f.id,
      name: f.name,
      mime_type: f.mimeType,
      modified_time: f.modifiedTime,
      size: f.size,
      web_view_link: f.webViewLink,
    }));

  const reply: ListFilesReply = { ok: true, files };
  if (body.nextPageToken) reply.next_page_token = body.nextPageToken;
  return reply;
}

export async function handleGet(
  req: GetFileRequest,
): Promise<FilesReply<GetFileReply>> {
  if (!req.user_id || !req.file_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id and file_id required" },
    };
  }
  let token: string;
  try {
    const minted = await mintGoogleToken(req.user_id, DRIVE_READONLY_SCOPE);
    token = minted.accessToken;
  } catch (err) {
    if (err instanceof CredentialError) return credentialErrorReply(err);
    throw err;
  }

  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(req.file_id)}`);
  url.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,size,webViewLink",
  );
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());

  const f = (await resp.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    modifiedTime?: string;
    size?: string;
    webViewLink?: string;
  };
  if (!f.id || !f.name || !f.mimeType) {
    return {
      ok: false,
      error: { code: "drive_api_error", message: "drive returned partial file metadata" },
    };
  }
  return {
    ok: true,
    file: {
      id: f.id,
      name: f.name,
      mime_type: f.mimeType,
      modified_time: f.modifiedTime,
      size: f.size,
      web_view_link: f.webViewLink,
    },
  };
}

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export async function handleDownload(
  req: DownloadFileRequest,
): Promise<FilesReply<DownloadFileReply>> {
  if (!req.user_id || !req.file_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id and file_id required" },
    };
  }
  let token: string;
  try {
    const minted = await mintGoogleToken(req.user_id, DRIVE_READONLY_SCOPE);
    token = minted.accessToken;
  } catch (err) {
    if (err instanceof CredentialError) return credentialErrorReply(err);
    throw err;
  }

  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(req.file_id)}`);
  url.searchParams.set("alt", "media");
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());

  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      error: {
        code: "file_too_large",
        message: `file is ${buf.byteLength} bytes; cap is ${MAX_DOWNLOAD_BYTES}. Use a chunked path or call drive directly with the access token.`,
      },
    };
  }

  return {
    ok: true,
    content_base64: Buffer.from(buf).toString("base64"),
    mime_type: resp.headers.get("content-type") ?? "application/octet-stream",
    size_bytes: buf.byteLength,
  };
}
