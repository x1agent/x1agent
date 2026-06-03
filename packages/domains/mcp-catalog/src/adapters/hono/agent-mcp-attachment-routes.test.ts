import { describe, expect, it } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentMcpAttachmentRoutes } from "./routes.js";
import type { AttachmentService } from "../../application/attachment-service.js";

// Stand-in for the composition layer's requireAuth: pass-through.
const passingAuth: MiddlewareHandler = async (_c, next) => {
  await next();
};

// Tags context so each handler can be asserted to have run the
// expected guard. The route factory shouldn't, for example, run
// requireAgentWrite on GET /.
function tagger(
  tag: "read" | "write",
  allow: boolean,
): MiddlewareHandler {
  return async (c, next) => {
    if (!allow) return c.json({ error: "forbidden", tag }, 403);
    c.set("workspaceId", "ws-1");
    c.set("userId", "user-1");
    c.set("agentKind", "worker");
    c.set("workspaceAllowsOauthOnNonWorkers", true);
    c.set("guardTag", tag);
    await next();
  };
}

declare module "hono" {
  interface ContextVariableMap {
    guardTag: "read" | "write";
  }
}

const stubAttachments: AttachmentService = {
  list: async () => [],
  attach: async () =>
    ({
      id: "att-1",
      agentId: "agent-1",
      catalogEntryId: "cat-1",
      envJson: {},
      toolScopesGranted: [],
      createdAt: new Date(0),
      updatedAt: new Date(0),
      createdBy: "user-1",
    } as never),
  detach: async () => true,
} as unknown as AttachmentService;

function mount(opts: {
  readAllow: boolean;
  writeAllow: boolean;
  attachments?: AttachmentService;
  catalogById?: Map<
    string,
    { id: string; name: string; displayName: string | null; kind: string }
  >;
  userTokenCatalogIds?: string[];
}) {
  const app = new Hono();
  app.route(
    "/api/workspaces/:slug/agents/:agentId/mcp-attachments",
    createAgentMcpAttachmentRoutes({
      attachments: opts.attachments ?? stubAttachments,
      requireAuth: passingAuth,
      requireAgentRead: tagger("read", opts.readAllow),
      requireAgentWrite: tagger("write", opts.writeAllow),
      catalog: {
        getById: async (_w, id) => opts.catalogById?.get(id) ?? null,
      },
      userTokens: {
        listForUser: async () =>
          (opts.userTokenCatalogIds ?? []).map((catalogEntryId) => ({
            catalogEntryId,
          })),
      },
    }),
  );
  return app;
}

describe("createAgentMcpAttachmentRoutes — read/write split", () => {
  it("GET / passes through requireAgentRead, not requireAgentWrite", async () => {
    const app = mount({ readAllow: true, writeAllow: false });
    const res = await app.fetch(
      new Request("http://t/api/workspaces/w/agents/a/mcp-attachments"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: unknown[] };
    expect(body.attachments).toEqual([]);
  });

  it("GET / is denied when requireAgentRead denies", async () => {
    const app = mount({ readAllow: false, writeAllow: true });
    const res = await app.fetch(
      new Request("http://t/api/workspaces/w/agents/a/mcp-attachments"),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { tag: string };
    expect(body.tag).toBe("read");
  });

  it("PUT / passes through requireAgentWrite, not requireAgentRead", async () => {
    const app = mount({ readAllow: false, writeAllow: true });
    const res = await app.fetch(
      new Request("http://t/api/workspaces/w/agents/a/mcp-attachments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalog_entry_id: "cat-1" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("PUT / is denied when requireAgentWrite denies, even if read allows", async () => {
    const app = mount({ readAllow: true, writeAllow: false });
    const res = await app.fetch(
      new Request("http://t/api/workspaces/w/agents/a/mcp-attachments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalog_entry_id: "cat-1" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { tag: string };
    expect(body.tag).toBe("write");
  });

  it("DELETE /:id requires write guard", async () => {
    const denied = mount({ readAllow: true, writeAllow: false });
    const r1 = await denied.fetch(
      new Request("http://t/api/workspaces/w/agents/a/mcp-attachments/x", {
        method: "DELETE",
      }),
    );
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as { tag: string }).tag).toBe("write");

    const allowed = mount({ readAllow: false, writeAllow: true });
    const r2 = await allowed.fetch(
      new Request("http://t/api/workspaces/w/agents/a/mcp-attachments/x", {
        method: "DELETE",
      }),
    );
    expect(r2.status).toBe(204);
  });

  it("GET / redacts kind:value literals from the wire response", async () => {
    // Even an admin should not see the raw value back — those exist
    // only to be injected into the MCP at session-launch, never to
    // round-trip through this api.
    const listing: AttachmentService = {
      list: async () =>
        [
          {
            id: "att-1",
            agentId: "agent-1",
            catalogEntryId: "cat-1",
            envJson: {
              REGION: { kind: "value", value: "us-east-1-PLAINTEXT" },
              API_KEY: { kind: "secret", ref: "OPENAI_PROD" },
            },
            toolScopesGranted: [],
            createdAt: new Date(0),
            updatedAt: new Date(0),
            createdBy: "user-1",
          },
        ] as never,
      attach: async () => ({} as never),
      detach: async () => true,
    } as unknown as AttachmentService;
    const app = new Hono();
    app.route(
      "/api/workspaces/:slug/agents/:agentId/mcp-attachments",
      createAgentMcpAttachmentRoutes({
        attachments: listing,
        requireAuth: passingAuth,
        requireAgentRead: tagger("read", true),
        requireAgentWrite: tagger("write", true),
        catalog: { getById: async () => null },
        userTokens: { listForUser: async () => [] },
      }),
    );
    const res = await app.fetch(
      new Request("http://t/api/workspaces/w/agents/a/mcp-attachments"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachments: {
        env_json: Record<string, { kind: string; value?: string; ref?: string }>;
      }[];
    };
    const env = body.attachments[0]!.env_json;
    expect(env.REGION!.kind).toBe("value");
    expect(env.REGION!.value).toBe("");
    expect(JSON.stringify(body)).not.toContain("us-east-1-PLAINTEXT");
    // Secret refs are still surfaced (workspace-secret names are not
    // sensitive — the values they resolve to are).
    expect(env.API_KEY).toEqual({ kind: "secret", ref: "OPENAI_PROD" });
  });
});

describe("createAgentMcpAttachmentRoutes — per-user connection-status endpoint", () => {
  it("returns one entry per remote_oauth attachment, each marked connected or not for the calling user", async () => {
    const attachments = {
      list: async () => [
        { id: "att-1", agentId: "agent-1", catalogEntryId: "cat-connected", envJson: {}, toolScopesGranted: [], createdAt: new Date(0), updatedAt: new Date(0), createdBy: null },
        { id: "att-2", agentId: "agent-1", catalogEntryId: "cat-disconnected", envJson: {}, toolScopesGranted: [], createdAt: new Date(0), updatedAt: new Date(0), createdBy: null },
      ],
    } as unknown as AttachmentService;
    const catalogById = new Map([
      [
        "cat-connected",
        {
          id: "cat-connected",
          name: "provider-a",
          displayName: "Provider A",
          kind: "remote_oauth",
        },
      ],
      [
        "cat-disconnected",
        {
          id: "cat-disconnected",
          name: "provider-b",
          displayName: "Provider B",
          kind: "remote_oauth",
        },
      ],
    ]);
    const app = mount({
      readAllow: true,
      writeAllow: false,
      attachments,
      catalogById,
      userTokenCatalogIds: ["cat-connected"],
    });
    const res = await app.fetch(
      new Request(
        "http://t/api/workspaces/w/agents/agent-1/mcp-attachments/connection-status",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: {
        catalog_entry_id: string;
        name: string;
        display_name: string | null;
        connected: boolean;
      }[];
    };
    expect(body.connections).toHaveLength(2);
    const byId = new Map(body.connections.map((c) => [c.catalog_entry_id, c]));
    expect(byId.get("cat-connected")?.connected).toBe(true);
    expect(byId.get("cat-disconnected")?.connected).toBe(false);
  });

  it("skips stdio (non-remote_oauth) catalog entries — they have no per-user connection state", async () => {
    const attachments = {
      list: async () => [
        { id: "att-1", agentId: "agent-1", catalogEntryId: "cat-oauth", envJson: {}, toolScopesGranted: [], createdAt: new Date(0), updatedAt: new Date(0), createdBy: null },
        { id: "att-2", agentId: "agent-1", catalogEntryId: "cat-stdio", envJson: {}, toolScopesGranted: [], createdAt: new Date(0), updatedAt: new Date(0), createdBy: null },
      ],
    } as unknown as AttachmentService;
    const catalogById = new Map([
      [
        "cat-oauth",
        {
          id: "cat-oauth",
          name: "provider-a",
          displayName: "Provider A",
          kind: "remote_oauth",
        },
      ],
      [
        "cat-stdio",
        {
          id: "cat-stdio",
          name: "stdio-helper",
          displayName: "Stdio Helper",
          kind: "stdio",
        },
      ],
    ]);
    const app = mount({
      readAllow: true,
      writeAllow: false,
      attachments,
      catalogById,
      userTokenCatalogIds: [],
    });
    const res = await app.fetch(
      new Request(
        "http://t/api/workspaces/w/agents/agent-1/mcp-attachments/connection-status",
      ),
    );
    const body = (await res.json()) as {
      connections: { catalog_entry_id: string }[];
    };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]!.catalog_entry_id).toBe("cat-oauth");
  });

  it("is gated by requireAgentRead — non-member callers are rejected", async () => {
    const app = mount({
      readAllow: false,
      writeAllow: true,
      catalogById: new Map(),
      userTokenCatalogIds: [],
    });
    const res = await app.fetch(
      new Request(
        "http://t/api/workspaces/w/agents/a/mcp-attachments/connection-status",
      ),
    );
    expect(res.status).toBe(403);
  });
});
