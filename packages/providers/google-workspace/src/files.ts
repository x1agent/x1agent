/**
 * `files` domain handlers for the google-workspace provider.
 *
 * Implements Drive read + write against Google Drive v3:
 *   x1.provider.files.list             → GET drive/v3/files (q=)
 *   x1.provider.files.get              → GET drive/v3/files/{id}
 *   x1.provider.files.download         → GET drive/v3/files/{id}?alt=media
 *   x1.provider.files.upload           → POST upload/drive/v3/files (multipart)
 *   x1.provider.files.update_content   → PATCH upload/drive/v3/files/{id}?uploadType=media
 *   x1.provider.files.update_metadata  → PATCH drive/v3/files/{id}
 *   x1.provider.files.create_folder    → POST drive/v3/files (mimeType=folder)
 *   x1.provider.files.trash            → PATCH drive/v3/files/{id} {trashed:true}
 *
 * Reads use `drive.readonly`. Writes use the broader `drive` scope
 * (Restricted in Google's taxonomy — Internal-user-type installs
 * skip review; External installs need CASA audit before rolling out
 * write paths to non-org users). Same code; the credential proxy
 * enforces scope at token mint time.
 *
 * Each handler mints a fresh user OAuth token via the api's internal
 * credential proxy (see credential.ts). Tokens are held in memory for
 * the duration of one outbound Drive call and never persisted.
 */

import { CredentialError, mintGoogleToken } from "./credential.js";

const DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

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

// ── Write paths ──────────────────────────────────────────

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,parents";

function fileFromGoogle(f: {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
}): FileEntry | null {
  if (!f.id || !f.name || !f.mimeType) return null;
  return {
    id: f.id,
    name: f.name,
    mime_type: f.mimeType,
    modified_time: f.modifiedTime,
    size: f.size,
    web_view_link: f.webViewLink,
  };
}

export interface UploadFileRequest {
  user_id: string;
  name: string;
  /** Optional Drive folder id; defaults to "My Drive" root. */
  parent_folder_id?: string;
  /** Base64-encoded bytes. Caps at MAX_UPLOAD_BYTES. */
  content_base64: string;
  /** Defaults to application/octet-stream. */
  mime_type?: string;
}

export interface UpdateFileContentRequest {
  user_id: string;
  file_id: string;
  content_base64: string;
  /** Optional — when set, also rewrites the file's mimeType. */
  mime_type?: string;
}

export interface UpdateFileMetadataRequest {
  user_id: string;
  file_id: string;
  /** Optional new name. */
  name?: string;
  /**
   * Optional new parent folder id. Replaces existing parents (Drive
   * supports multi-parent but we don't expose that complexity).
   */
  parent_folder_id?: string;
}

export interface CreateFolderRequest {
  user_id: string;
  name: string;
  /** Optional parent folder id; defaults to root. */
  parent_folder_id?: string;
}

export interface TrashFileRequest {
  user_id: string;
  file_id: string;
}

export interface FileMutationReply {
  ok: true;
  file: FileEntry;
}

export interface OkReply {
  ok: true;
}

async function mintWriteToken(
  userId: string,
): Promise<{ token: string } | ErrorReply> {
  try {
    const minted = await mintGoogleToken(userId, DRIVE_WRITE_SCOPE);
    return { token: minted.accessToken };
  } catch (err) {
    if (err instanceof CredentialError) {
      return {
        ok: false,
        error: {
          code: err.kind,
          message: err.message,
          required_scope:
            err.kind === "permission_required" ? DRIVE_WRITE_SCOPE : undefined,
        },
      };
    }
    throw err;
  }
}

export async function handleUpload(
  req: UploadFileRequest,
): Promise<FilesReply<FileMutationReply>> {
  if (!req.user_id || !req.name || typeof req.content_base64 !== "string") {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, name, content_base64 required",
      },
    };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(req.content_base64, "base64");
  } catch {
    return {
      ok: false,
      error: { code: "bad_base64", message: "content_base64 is not valid base64" },
    };
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: {
        code: "file_too_large",
        message: `payload is ${bytes.byteLength} bytes; cap is ${MAX_UPLOAD_BYTES}.`,
      },
    };
  }

  const minted = await mintWriteToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  // Drive multipart upload: a multipart/related body with two parts —
  // a JSON metadata part and a media part. We hand-build the
  // boundary because FormData maps to multipart/form-data, not /related.
  const metadata: Record<string, unknown> = { name: req.name };
  if (req.parent_folder_id) metadata.parents = [req.parent_folder_id];
  const mime = req.mime_type ?? "application/octet-stream";

  const boundary = `x1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = Buffer.concat([
    Buffer.from(head, "utf8"),
    bytes,
    Buffer.from(tail, "utf8"),
  ]);

  const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", FILE_FIELDS);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.byteLength),
    },
    body: new Uint8Array(body),
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());
  const f = (await resp.json()) as Parameters<typeof fileFromGoogle>[0];
  const file = fileFromGoogle(f);
  if (!file) {
    return {
      ok: false,
      error: { code: "drive_api_error", message: "drive returned partial metadata" },
    };
  }
  return { ok: true, file };
}

export async function handleUpdateContent(
  req: UpdateFileContentRequest,
): Promise<FilesReply<FileMutationReply>> {
  if (
    !req.user_id ||
    !req.file_id ||
    typeof req.content_base64 !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, file_id, content_base64 required",
      },
    };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(req.content_base64, "base64");
  } catch {
    return {
      ok: false,
      error: { code: "bad_base64", message: "content_base64 is not valid base64" },
    };
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: {
        code: "file_too_large",
        message: `payload is ${bytes.byteLength} bytes; cap is ${MAX_UPLOAD_BYTES}.`,
      },
    };
  }

  const minted = await mintWriteToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const url = new URL(
    `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(req.file_id)}`,
  );
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("fields", FILE_FIELDS);
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": req.mime_type ?? "application/octet-stream",
    },
    body: new Uint8Array(bytes),
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());
  const f = (await resp.json()) as Parameters<typeof fileFromGoogle>[0];
  const file = fileFromGoogle(f);
  if (!file) {
    return {
      ok: false,
      error: { code: "drive_api_error", message: "drive returned partial metadata" },
    };
  }
  return { ok: true, file };
}

export async function handleUpdateMetadata(
  req: UpdateFileMetadataRequest,
): Promise<FilesReply<FileMutationReply>> {
  if (!req.user_id || !req.file_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id and file_id required" },
    };
  }
  if (req.name === undefined && req.parent_folder_id === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "at least one of name, parent_folder_id required",
      },
    };
  }

  const minted = await mintWriteToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  // Drive's "move" via PATCH uses query params addParents / removeParents
  // — the file's `parents` field on the body is read-only on update.
  // For a simple "replace parent" UX we look up the current parent and
  // pass both addParents and removeParents in one PATCH.
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(req.file_id)}`);
  url.searchParams.set("fields", FILE_FIELDS);

  if (req.parent_folder_id !== undefined) {
    // Need current parents for removeParents. One extra GET; small cost,
    // and the alternative (asking the agent to know current parents) is
    // worse.
    const meta = await fetch(
      `${DRIVE_BASE}/files/${encodeURIComponent(req.file_id)}?fields=parents`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!meta.ok) return driveErrorReply(meta.status, await meta.text());
    const prev = (await meta.json()) as { parents?: string[] };
    if (prev.parents && prev.parents.length > 0) {
      url.searchParams.set("removeParents", prev.parents.join(","));
    }
    url.searchParams.set("addParents", req.parent_folder_id);
  }

  const body: Record<string, unknown> = {};
  if (req.name !== undefined) body.name = req.name;

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());
  const f = (await resp.json()) as Parameters<typeof fileFromGoogle>[0];
  const file = fileFromGoogle(f);
  if (!file) {
    return {
      ok: false,
      error: { code: "drive_api_error", message: "drive returned partial metadata" },
    };
  }
  return { ok: true, file };
}

export async function handleCreateFolder(
  req: CreateFolderRequest,
): Promise<FilesReply<FileMutationReply>> {
  if (!req.user_id || !req.name) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id and name required" },
    };
  }

  const minted = await mintWriteToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const body: Record<string, unknown> = {
    name: req.name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (req.parent_folder_id) body.parents = [req.parent_folder_id];

  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set("fields", FILE_FIELDS);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());
  const f = (await resp.json()) as Parameters<typeof fileFromGoogle>[0];
  const file = fileFromGoogle(f);
  if (!file) {
    return {
      ok: false,
      error: { code: "drive_api_error", message: "drive returned partial metadata" },
    };
  }
  return { ok: true, file };
}

export async function handleTrash(
  req: TrashFileRequest,
): Promise<FilesReply<OkReply>> {
  if (!req.user_id || !req.file_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id and file_id required" },
    };
  }

  const minted = await mintWriteToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  // Trash, not delete. Reversible from the user's Drive UI; an
  // accidental destructive action by an agent is recoverable. Hard
  // delete is intentionally not exposed.
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(req.file_id)}`);
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trashed: true }),
  });
  if (!resp.ok) return driveErrorReply(resp.status, await resp.text());
  return { ok: true };
}
