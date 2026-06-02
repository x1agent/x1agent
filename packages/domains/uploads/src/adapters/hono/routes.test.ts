import { describe, it, expect } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { FixedClock, UserId } from "@x1agent/kernel";
import { DEFAULT_UPLOADS_CONFIG } from "../../domain/config.js";
import { InMemoryUploadStorage } from "../in-memory-storage.js";
import { InMemoryRateLimiter } from "../in-memory-rate-limiter.js";
import { InMemoryUploadRepository } from "../../application/fakes.js";
import { createUploadRoutes } from "./routes.js";

const USER_A = UserId("aaaaaaaa-1111-7111-8111-111111111111");
const USER_B = UserId("bbbbbbbb-2222-7222-8222-222222222222");

function pngBytes(totalLen: number): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(Math.max(totalLen, head.length));
  out.set(head, 0);
  return out.subarray(0, totalLen);
}

interface Harness {
  app: Hono;
  uploads: InMemoryUploadRepository;
  storage: InMemoryUploadStorage;
  asUser: (id: ReturnType<typeof UserId>) => void;
}

function harness(): Harness {
  const clock = new FixedClock(new Date("2026-05-13T04:00:00Z"));
  const uploads = new InMemoryUploadRepository();
  const storage = new InMemoryUploadStorage();
  const rateLimiter = new InMemoryRateLimiter(clock);

  let activeUser: ReturnType<typeof UserId> | null = null;
  const requireAuth: MiddlewareHandler = async (c, next) => {
    if (!activeUser) return c.json({ error: "unauthenticated" }, 401);
    await next();
  };

  let counter = 0;
  const routes = createUploadRoutes({
    uploads,
    storage,
    rateLimiter,
    clock,
    config: DEFAULT_UPLOADS_CONFIG,
    uuid: () => {
      counter += 1;
      const n = counter.toString(16).padStart(12, "0");
      return `11111111-1111-7111-8111-${n}`;
    },
    requireAuth,
    getActor: () =>
      activeUser
        ? { userId: activeUser, email: "user@example.com" as never }
        : null,
  });

  const app = new Hono();
  app.route("/api/uploads", routes);
  return {
    app,
    uploads,
    storage,
    asUser: (id) => {
      activeUser = id;
    },
  };
}

describe("upload routes", () => {
  it("init → put → complete → get → delete", async () => {
    const h = harness();
    h.asUser(USER_A);

    const init = await h.app.request("/api/uploads/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "hello.png",
        mime_hint: "image/png",
        size_bytes: 16,
        session_id: null,
      }),
    });
    expect(init.status).toBe(200);
    const initBody = await init.json();
    expect(typeof initBody.upload_id).toBe("string");
    expect(initBody.method).toBe("PUT");

    // Put bytes through the storage adapter (skipping the signed-URL
    // hop since this harness uses InMemoryUploadStorage).
    const row = h.uploads.rows.get(initBody.upload_id)!;
    await h.storage.putObject(row.storageKey, pngBytes(16), "image/png");

    const complete = await h.app.request(
      `/api/uploads/${initBody.upload_id}/complete`,
      { method: "POST" },
    );
    expect(complete.status).toBe(200);
    const completeBody = await complete.json();
    expect(completeBody.mime).toBe("image/png");
    expect(completeBody.size_bytes).toBe(16);

    const meta = await h.app.request(`/api/uploads/${initBody.upload_id}`);
    expect(meta.status).toBe(200);

    const raw = await h.app.request(`/api/uploads/${initBody.upload_id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");

    const del = await h.app.request(`/api/uploads/${initBody.upload_id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(h.uploads.rows.get(initBody.upload_id)?.status).toBe("deleted");
  });

  it("foreign user gets 404 (no leak)", async () => {
    const h = harness();
    h.asUser(USER_A);
    const init = await h.app.request("/api/uploads/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "hello.png",
        mime_hint: "image/png",
        size_bytes: 16,
        session_id: null,
      }),
    });
    const { upload_id } = await init.json();

    h.asUser(USER_B);
    const meta = await h.app.request(`/api/uploads/${upload_id}`);
    expect(meta.status).toBe(404);

    const del = await h.app.request(`/api/uploads/${upload_id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });

  it("rejects non-UUID id parameter with 400", async () => {
    const h = harness();
    h.asUser(USER_A);
    const meta = await h.app.request("/api/uploads/..%2Fpasswd");
    expect(meta.status).toBe(400);
  });

  it("rejects oversized init with 400", async () => {
    const h = harness();
    h.asUser(USER_A);
    const r = await h.app.request("/api/uploads/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "huge.png",
        mime_hint: "image/png",
        size_bytes: DEFAULT_UPLOADS_CONFIG.maxBytes + 1,
        session_id: null,
      }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("upload_too_large");
  });

  it("rejects disallowed MIME at init with 400", async () => {
    const h = harness();
    h.asUser(USER_A);
    const r = await h.app.request("/api/uploads/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "archive.zip",
        mime_hint: "application/zip",
        size_bytes: 100,
        session_id: null,
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("mime_not_allowed");
  });

  it("double-complete returns 409", async () => {
    const h = harness();
    h.asUser(USER_A);
    const init = await h.app.request("/api/uploads/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "hello.png",
        mime_hint: "image/png",
        size_bytes: 16,
        session_id: null,
      }),
    });
    const { upload_id } = await init.json();
    const row = h.uploads.rows.get(upload_id)!;
    await h.storage.putObject(row.storageKey, pngBytes(16), "image/png");
    await h.app.request(`/api/uploads/${upload_id}/complete`, {
      method: "POST",
    });
    const second = await h.app.request(`/api/uploads/${upload_id}/complete`, {
      method: "POST",
    });
    expect(second.status).toBe(409);
  });
});
