import { describe, it, expect, beforeEach } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createPlatformSecretsRoutes } from "./routes.js";
import {
  PlatformSecretsUnavailableError,
  type PlatformSecretsStore,
} from "./store.js";

/**
 * Route-level unit tests. Hits the Hono app via .fetch() so we exercise
 * the middleware stack + status codes + headers, but mocks out the
 * PlatformSecretsStore (so no real K8s API calls) and pins process.env
 * via readEnv override.
 */

function authMiddleware(email: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (email === null) {
      // Skip setting session; downstream middleware should 401.
      await next();
      return;
    }
    // c.set("session", value) on the Hono context — bypass the typed
    // overload (Hono types "session" against a known map) since this
    // test middleware is the only writer in the request lifecycle.
    (c.set as (k: string, v: unknown) => void)("session", { email });
    await next();
  };
}

class FakeStore implements PlatformSecretsStore {
  calls: Array<{ op: string; args: unknown[] }> = [];
  setError?: Error;
  clearError?: Error;
  rolloutError?: Error;
  // eslint-disable-next-line @typescript-eslint/require-await
  async setKey(name: string, value: string): Promise<void> {
    this.calls.push({ op: "setKey", args: [name, value] });
    if (this.setError) throw this.setError;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async clearKey(name: string): Promise<void> {
    this.calls.push({ op: "clearKey", args: [name] });
    if (this.clearError) throw this.clearError;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async rolloutRestartApi(): Promise<void> {
    this.calls.push({ op: "rollout", args: [] });
    if (this.rolloutError) throw this.rolloutError;
  }
}

const ADMIN_EMAIL = "admin@example.com";
const NON_ADMIN_EMAIL = "stranger@example.com";

function buildApp(opts: {
  caller: string | null;
  store?: FakeStore;
  env?: Record<string, string | undefined>;
}) {
  const store = opts.store ?? new FakeStore();
  return {
    store,
    app: createPlatformSecretsRoutes({
      platformAdmins: [ADMIN_EMAIL],
      requireAuth: authMiddleware(opts.caller),
      store,
      readEnv: () => opts.env ?? {},
    }),
  };
}

describe("createPlatformSecretsRoutes — auth gating", () => {
  it("401 when there is no session", async () => {
    const { app } = buildApp({ caller: null });
    const res = await app.request("/llm");
    expect(res.status).toBe(401);
  });

  it("403 when the caller is authenticated but not on the platform-admins allowlist", async () => {
    const { app } = buildApp({ caller: NON_ADMIN_EMAIL });
    for (const path of [
      ["GET", "/llm"],
      ["GET", "/llm/anthropic"],
      ["PUT", "/llm/anthropic"],
      ["DELETE", "/llm/anthropic"],
    ] as const) {
      const res = await app.request(path[1], {
        method: path[0],
        headers: { "content-type": "application/json" },
        body: path[0] === "PUT" ? JSON.stringify({ value: "sk-1" }) : undefined,
      });
      expect(res.status).toBe(403);
    }
  });
});

describe("createPlatformSecretsRoutes — GET /llm", () => {
  it("returns providers with configured booleans only — no values", async () => {
    const { app } = buildApp({
      caller: ADMIN_EMAIL,
      env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    });
    const res = await app.request("/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ provider: string; configured: boolean }>;
    };
    expect(body.providers).toEqual([
      { provider: "anthropic", configured: true },
      { provider: "openai", configured: false },
    ]);
    // Defense in depth: no field in the response carries any prefix of
    // the key value. Catches accidental "echo what we just stored" bugs.
    expect(JSON.stringify(body)).not.toContain("sk-ant");
  });
});

describe("createPlatformSecretsRoutes — PUT /llm/:provider", () => {
  let fake: FakeStore;
  beforeEach(() => {
    fake = new FakeStore();
  });

  it("writes the value under the env-var name and rolls the api deployment", async () => {
    const { app, store } = buildApp({ caller: ADMIN_EMAIL, store: fake });
    const res = await app.request("/llm/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-real" }),
    });
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([
      { op: "setKey", args: ["OPENAI_API_KEY", "sk-real"] },
      { op: "rollout", args: [] },
    ]);
  });

  it("rejects an unknown provider with 400", async () => {
    const { app } = buildApp({ caller: ADMIN_EMAIL });
    const res = await app.request("/llm/cohere", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty / whitespace-only value with 400 and does NOT write", async () => {
    const { app, store } = buildApp({ caller: ADMIN_EMAIL, store: fake });
    const res = await app.request("/llm/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "   " }),
    });
    expect(res.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("503 when the underlying store reports unavailable (no kube config)", async () => {
    fake.setError = new PlatformSecretsUnavailableError();
    const { app } = buildApp({ caller: ADMIN_EMAIL, store: fake });
    const res = await app.request("/llm/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-x" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("createPlatformSecretsRoutes — DELETE /llm/:provider", () => {
  it("clears the env-var entry and rolls the api deployment", async () => {
    const fake = new FakeStore();
    const { app, store } = buildApp({ caller: ADMIN_EMAIL, store: fake });
    const res = await app.request("/llm/anthropic", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(store.calls).toEqual([
      { op: "clearKey", args: ["ANTHROPIC_API_KEY"] },
      { op: "rollout", args: [] },
    ]);
  });

  it("is idempotent — calling clear twice still returns 200", async () => {
    const fake = new FakeStore();
    const { app } = buildApp({ caller: ADMIN_EMAIL, store: fake });
    const first = await app.request("/llm/openai", { method: "DELETE" });
    const second = await app.request("/llm/openai", { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
