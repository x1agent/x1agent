import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "./composition/index.js";
import { freshTestDb, dropTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_uploads_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let app: Hono;
let uploadsDir: string;

function pngBytes(totalLen: number): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(Math.max(totalLen, head.length));
  out.set(head, 0);
  return out.subarray(0, totalLen);
}

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), "x1a-uploads-it-"));
  const db = await freshTestDb(TEST_DB);
  dbSql = db.sql;
  process.env.DATABASE_URL = db.url;
  process.env.UPLOAD_STORAGE_BACKEND = "local";
  process.env.UPLOAD_STORAGE_PATH = uploadsDir;
  const { resetSql } = await import("./db/client.js");
  await resetSql();

  await dbSql<{ id: string }[]>`
    INSERT INTO workspaces (slug, name) VALUES ('default', 'Default')
    RETURNING id
  `;
  await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice')
    RETURNING id
  `;
  await dbSql<{ id: string }[]>`
    INSERT INTO users (email, name) VALUES ('bob@example.com', 'Bob')
    RETURNING id
  `;

  process.env.TEST_USER = "alice@example.com";

  const composed = compose({
    sql: dbSql,
    jwtSecret: "integration-test-secret",
    googleClientId: "placeholder",
    googleClientSecret: "placeholder",
    appUrl: "http://app.test",
    apiUrl: "http://api.test",
    allowedDomains: [],
    platformAdmins: [],
    authBypass: true,
    testUserEmail: "alice@example.com",
    platformName: "x1agent",
    workspaceSecretsMasterKey: "0".repeat(64),
  });

  app = new Hono();
  app.route("/auth", composed.authRoutes);
  app.route("/api/uploads", composed.uploadRoutes);
});

afterAll(async () => {
  if (dbSql) await dbSql.end();
  const { resetSql } = await import("./db/client.js");
  await resetSql();
  await dropTestDb(TEST_DB);
  await rm(uploadsDir, { recursive: true, force: true });
});

function cookieFromRes(res: Response): string {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/x1_session=([^;]+)/);
  if (!m) throw new Error("no session cookie");
  return `x1_session=${m[1]}`;
}

async function login(email: string): Promise<string> {
  process.env.TEST_USER = email;
  const { resetSql } = await import("./db/client.js");
  await resetSql();
  const composed = compose({
    sql: dbSql,
    jwtSecret: "integration-test-secret",
    googleClientId: "placeholder",
    googleClientSecret: "placeholder",
    appUrl: "http://app.test",
    apiUrl: "http://api.test",
    allowedDomains: [],
    platformAdmins: [],
    authBypass: true,
    testUserEmail: email,
    platformName: "x1agent",
    workspaceSecretsMasterKey: "0".repeat(64),
  });
  const fresh = new Hono();
  fresh.route("/auth", composed.authRoutes);
  const res = await fresh.fetch(new Request("http://api.test/auth/bypass"));
  return cookieFromRes(res);
}

describe("uploads integration", () => {
  it("init → signed-PUT → complete → GET raw → DELETE", async () => {
    const c = await login("alice@example.com");

    const init = await app.fetch(
      new Request("http://api.test/api/uploads/init", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: c },
        body: JSON.stringify({
          filename: "ok.png",
          mime_hint: "image/png",
          size_bytes: 16,
          session_id: null,
        }),
      }),
    );
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as {
      upload_id: string;
      upload_url: string;
    };

    // PUT bytes through the signed-URL endpoint. Note: NO cookie —
    // signed-URL ingress runs before requireAuth.
    const putUrl = initBody.upload_url.replace("http://api.test", "");
    const put = await app.fetch(
      new Request(`http://api.test${putUrl}`, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: pngBytes(16),
      }),
    );
    expect(put.status).toBe(200);

    const complete = await app.fetch(
      new Request(
        `http://api.test/api/uploads/${initBody.upload_id}/complete`,
        { method: "POST", headers: { cookie: c } },
      ),
    );
    expect(complete.status).toBe(200);

    const raw = await app.fetch(
      new Request(`http://api.test/api/uploads/${initBody.upload_id}/raw`, {
        headers: { cookie: c },
      }),
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");

    const del = await app.fetch(
      new Request(`http://api.test/api/uploads/${initBody.upload_id}`, {
        method: "DELETE",
        headers: { cookie: c },
      }),
    );
    expect(del.status).toBe(200);
  });

  it("foreign user 404s on metadata", async () => {
    const cAlice = await login("alice@example.com");
    const init = await app.fetch(
      new Request("http://api.test/api/uploads/init", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cAlice },
        body: JSON.stringify({
          filename: "alice.png",
          mime_hint: "image/png",
          size_bytes: 16,
          session_id: null,
        }),
      }),
    );
    const { upload_id } = (await init.json()) as { upload_id: string };

    const cBob = await login("bob@example.com");
    const meta = await app.fetch(
      new Request(`http://api.test/api/uploads/${upload_id}`, {
        headers: { cookie: cBob },
      }),
    );
    expect(meta.status).toBe(404);
  });

  it("rejects non-UUID id with 400", async () => {
    const c = await login("alice@example.com");
    const meta = await app.fetch(
      new Request("http://api.test/api/uploads/not-a-uuid", {
        headers: { cookie: c },
      }),
    );
    expect(meta.status).toBe(400);
  });

  it("size_mismatch on PUT-then-complete", async () => {
    const c = await login("alice@example.com");
    const init = await app.fetch(
      new Request("http://api.test/api/uploads/init", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: c },
        body: JSON.stringify({
          filename: "short.png",
          mime_hint: "image/png",
          size_bytes: 16,
          session_id: null,
        }),
      }),
    );
    const { upload_id, upload_url } = (await init.json()) as {
      upload_id: string;
      upload_url: string;
    };
    // PUT 8 bytes when 16 declared — signed-PUT must reject.
    const putUrl = upload_url.replace("http://api.test", "");
    const put = await app.fetch(
      new Request(`http://api.test${putUrl}`, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: pngBytes(8),
      }),
    );
    expect(put.status).toBe(400);
    expect((await put.json()).error).toBe("size_mismatch");
  });
});
