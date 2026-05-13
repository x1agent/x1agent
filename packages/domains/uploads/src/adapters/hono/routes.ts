import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DomainError, type Clock, type Email, type UserId } from "@x1agent/kernel";
import type { UploadsConfig } from "../../domain/config.js";
import { UploadId } from "../../domain/upload.js";
import {
  UploadAlreadyCompletedError,
  UploadExpiredError,
  UploadMimeMismatchError,
  UploadMimeNotAllowedError,
  UploadNotFoundError,
  UploadNotOwnedError,
  UploadSizeMismatchError,
  UploadTooLargeError,
} from "../../domain/errors.js";
import {
  initUpload,
  type InitUploadDeps,
} from "../../application/init-upload.js";
import {
  completeUpload,
  type CompleteUploadDeps,
} from "../../application/complete-upload.js";
import { getOwnedUpload } from "../../application/get-upload.js";
import { deleteUpload } from "../../application/delete-upload.js";
import type { UploadRepository } from "../../ports/upload-repository.js";
import type { UploadStorage } from "../../ports/upload-storage.js";
import type { RateLimiter } from "../../ports/rate-limiter.js";
import { uploadInitKey } from "../../ports/rate-limiter.js";
import { LocalDiskStorage } from "../local-disk/local-disk-storage.js";

export interface UploadRoutesConfig {
  uploads: UploadRepository;
  storage: UploadStorage;
  rateLimiter: RateLimiter;
  clock: Clock;
  config: UploadsConfig;
  uuid: () => string;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
}

/**
 * Mounted at `/api/uploads`.
 *
 * Endpoints:
 *   POST   /init            — create pending row + issue upload URL
 *   PUT    /:id/raw         — signed-URL ingress (LocalDiskStorage only)
 *   POST   /:id/complete    — sniff + verify + mark ready
 *   GET    /:id             — metadata
 *   GET    /:id/raw         — stream bytes (owner only)
 *   DELETE /:id             — soft-delete
 *
 * ACL: every route resolves the upload via `getOwnedUpload`, which
 * 404s on cross-tenant / foreign-user / non-existent ids. The id
 * parameter is wrapped through `UploadId()` so non-UUID payloads
 * surface as 400 before any DB read.
 */
export function createUploadRoutes(cfg: UploadRoutesConfig) {
  const app = new Hono();

  // PUT /:id/raw — signed-URL ingress for LocalDiskStorage. Mounted
  // BEFORE the auth middleware because the HMAC token IS the auth
  // here (presigned URLs are bearer-equivalent). The endpoint refuses
  // to operate unless storage is LocalDiskStorage; the route still
  // exists in S3 mode but always returns 404 (clients use the
  // presigned S3 URL directly).
  app.put("/:id/raw", async (c) => {
    if (!(cfg.storage instanceof LocalDiskStorage)) {
      return c.json({ error: "not_supported" }, 404);
    }
    const idRaw = c.req.param("id");
    let id;
    try {
      id = UploadId(idRaw);
    } catch {
      return c.json({ error: "invalid_id" }, 400);
    }
    const expRaw = c.req.query("exp");
    const lenRaw = c.req.query("len");
    const ct = c.req.query("ct");
    const sig = c.req.query("sig");
    if (!expRaw || !lenRaw || !ct || !sig) {
      return c.json({ error: "missing_signature" }, 400);
    }
    const expSec = Number(expRaw);
    const len = Number(lenRaw);
    if (!Number.isFinite(expSec) || !Number.isFinite(len)) {
      return c.json({ error: "invalid_signature" }, 400);
    }

    const upload = await cfg.uploads.findById(id);
    if (!upload || upload.status !== "pending") {
      return c.json({ error: "upload_not_found" }, 404);
    }
    try {
      cfg.storage.verifyUploadToken({
        key: upload.storageKey,
        expSec,
        len,
        contentType: ct,
        sig,
      });
    } catch (err) {
      return c.json(
        { error: (err as Error).message || "invalid_signature" },
        400,
      );
    }
    if (len !== upload.sizeBytes) {
      return c.json({ error: "size_mismatch" }, 400);
    }
    const ab = await c.req.arrayBuffer();
    if (ab.byteLength !== len) {
      return c.json({ error: "size_mismatch" }, 400);
    }
    if (ab.byteLength > cfg.config.maxBytes) {
      return c.json({ error: "upload_too_large" }, 400);
    }
    await cfg.storage.putObject(upload.storageKey, new Uint8Array(ab), ct);
    return c.json({ ok: true });
  });

  // All remaining routes require an authenticated user.
  app.use("*", cfg.requireAuth);

  app.post("/init", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);

    const ok = await cfg.rateLimiter.tryConsume(
      uploadInitKey(actor.userId),
      cfg.config.initPerMinute,
      60_000,
    );
    if (!ok) return c.json({ error: "rate_limited" }, 429);

    let body: {
      filename?: unknown;
      mime_hint?: unknown;
      size_bytes?: unknown;
      session_id?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const filename = typeof body.filename === "string" ? body.filename : "";
    const mimeHint = typeof body.mime_hint === "string" ? body.mime_hint : "";
    const sizeBytes =
      typeof body.size_bytes === "number" ? body.size_bytes : NaN;
    const sessionId =
      typeof body.session_id === "string" ? body.session_id : null;
    if (!filename || !mimeHint || !Number.isFinite(sizeBytes)) {
      return c.json({ error: "invalid_body" }, 400);
    }

    const deps: InitUploadDeps = {
      uploads: cfg.uploads,
      storage: cfg.storage,
      clock: cfg.clock,
      config: cfg.config,
      uuid: () => UploadId(cfg.uuid()),
    };
    try {
      const { upload, uploadUrl } = await initUpload(deps, {
        userId: actor.userId,
        filename,
        mimeHint,
        sizeBytes,
        sessionId,
      });
      return c.json({
        upload_id: upload.id,
        upload_url: uploadUrl.url,
        method: uploadUrl.method,
        headers: uploadUrl.headers,
        expires_at: upload.expiresAt.toISOString(),
      });
    } catch (err) {
      return c.json(errBody(err), statusFor(err));
    }
  });

  app.post("/:id/complete", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    let id;
    try {
      id = UploadId(c.req.param("id"));
    } catch {
      return c.json({ error: "invalid_id" }, 400);
    }
    const deps: CompleteUploadDeps = {
      uploads: cfg.uploads,
      storage: cfg.storage,
      clock: cfg.clock,
      config: cfg.config,
    };
    try {
      const upload = await completeUpload(deps, {
        uploadId: id,
        userId: actor.userId,
      });
      return c.json({
        upload_id: upload.id,
        mime: upload.mime,
        size_bytes: upload.sizeBytes,
        filename: upload.filename,
      });
    } catch (err) {
      return c.json(errBody(err), statusFor(err));
    }
  });

  app.get("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    let id;
    try {
      id = UploadId(c.req.param("id"));
    } catch {
      return c.json({ error: "invalid_id" }, 400);
    }
    try {
      const upload = await getOwnedUpload(cfg.uploads, id, actor.userId);
      return c.json({
        upload_id: upload.id,
        filename: upload.filename,
        mime: upload.mime,
        size_bytes: upload.sizeBytes,
        status: upload.status,
        created_at: upload.createdAt.toISOString(),
        expires_at: upload.expiresAt.toISOString(),
      });
    } catch (err) {
      return c.json(errBody(err), statusFor(err));
    }
  });

  app.get("/:id/raw", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    let id;
    try {
      id = UploadId(c.req.param("id"));
    } catch {
      return c.json({ error: "invalid_id" }, 400);
    }
    try {
      const upload = await getOwnedUpload(cfg.uploads, id, actor.userId);
      if (upload.status !== "ready" && upload.status !== "attached") {
        return c.json({ error: "upload_not_ready" }, 409);
      }
      const body = await cfg.storage.readObject(upload.storageKey);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": upload.mime,
          "Content-Length": String(upload.sizeBytes),
          // Make sure nothing intermediate caches owner-scoped bytes.
          "Cache-Control": "private, no-store",
        },
      });
    } catch (err) {
      return c.json(errBody(err), statusFor(err));
    }
  });

  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    let id;
    try {
      id = UploadId(c.req.param("id"));
    } catch {
      return c.json({ error: "invalid_id" }, 400);
    }
    try {
      await deleteUpload(cfg.uploads, id, actor.userId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(errBody(err), statusFor(err));
    }
  });

  return app;
}

function statusFor(err: unknown): number {
  if (err instanceof UploadNotFoundError) return 404;
  if (err instanceof UploadNotOwnedError) return 404; // don't leak existence
  if (err instanceof UploadAlreadyCompletedError) return 409;
  if (err instanceof UploadExpiredError) return 410;
  if (err instanceof UploadTooLargeError) return 400;
  if (err instanceof UploadMimeNotAllowedError) return 400;
  if (err instanceof UploadMimeMismatchError) return 400;
  if (err instanceof UploadSizeMismatchError) return 400;
  if (err instanceof DomainError) return 400;
  return 500;
}

function errBody(err: unknown): { error: string; message?: string } {
  if (err instanceof DomainError) {
    return { error: err.code, message: err.message };
  }
  return { error: "internal" };
}
