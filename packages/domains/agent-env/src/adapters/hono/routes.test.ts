import { describe, expect, it } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentEnvRoutes } from "./routes.js";
import type { BindingService } from "../../application/binding-service.js";

const passingAuth: MiddlewareHandler = async (_c, next) => {
  await next();
};

function tagger(tag: "read" | "write", allow: boolean): MiddlewareHandler {
  return async (c, next) => {
    if (!allow) return c.json({ error: "forbidden", tag }, 403);
    c.set("workspaceId", "ws-1");
    c.set("userId", "user-1");
    await next();
  };
}

const stub: BindingService = {
  list: async () => [],
  set: async () =>
    ({
      id: "b-1",
      agentId: "a-1",
      envName: "FOO",
      secretName: "foo",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      createdBy: "user-1",
    } as never),
  delete: async () => true,
} as unknown as BindingService;

function mount(opts: { readAllow: boolean; writeAllow: boolean }) {
  const app = new Hono();
  app.route(
    "/api/workspaces/:slug/agents/:agentId/env",
    createAgentEnvRoutes({
      service: stub,
      requireAuth: passingAuth,
      requireAgentRead: tagger("read", opts.readAllow),
      requireAgentWrite: tagger("write", opts.writeAllow),
    }),
  );
  return app;
}

describe("createAgentEnvRoutes — read/write split", () => {
  it("GET / passes through requireAgentRead", async () => {
    const app = mount({ readAllow: true, writeAllow: false });
    const res = await app.fetch(
      new Request("http://t/api/workspaces/w/agents/a/env"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: unknown[] };
    expect(body.bindings).toEqual([]);
  });

  it("GET / is denied when read guard denies", async () => {
    const app = mount({ readAllow: false, writeAllow: true });
    const res = await app.fetch(
      new Request("http://t/api/workspaces/w/agents/a/env"),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { tag: string }).tag).toBe("read");
  });

  it("PUT /:envName requires write guard", async () => {
    const denied = mount({ readAllow: true, writeAllow: false });
    const r1 = await denied.fetch(
      new Request("http://t/api/workspaces/w/agents/a/env/FOO", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret_name: "foo" }),
      }),
    );
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as { tag: string }).tag).toBe("write");

    const allowed = mount({ readAllow: false, writeAllow: true });
    const r2 = await allowed.fetch(
      new Request("http://t/api/workspaces/w/agents/a/env/FOO", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret_name: "foo" }),
      }),
    );
    expect(r2.status).toBe(200);
  });

  it("DELETE /:envName requires write guard", async () => {
    const denied = mount({ readAllow: true, writeAllow: false });
    const r1 = await denied.fetch(
      new Request("http://t/api/workspaces/w/agents/a/env/FOO", {
        method: "DELETE",
      }),
    );
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as { tag: string }).tag).toBe("write");

    const allowed = mount({ readAllow: false, writeAllow: true });
    const r2 = await allowed.fetch(
      new Request("http://t/api/workspaces/w/agents/a/env/FOO", {
        method: "DELETE",
      }),
    );
    expect(r2.status).toBe(204);
  });
});
