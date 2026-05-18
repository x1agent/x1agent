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

function mount(opts: { readAllow: boolean; writeAllow: boolean }) {
  const app = new Hono();
  app.route(
    "/api/workspaces/:slug/agents/:agentId/mcp-attachments",
    createAgentMcpAttachmentRoutes({
      attachments: stubAttachments,
      requireAuth: passingAuth,
      requireAgentRead: tagger("read", opts.readAllow),
      requireAgentWrite: tagger("write", opts.writeAllow),
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
});
