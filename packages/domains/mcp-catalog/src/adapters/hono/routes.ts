import { Hono, type MiddlewareHandler } from "hono";
import type { CatalogService } from "../../application/catalog-service.js";
import type { AttachmentService } from "../../application/attachment-service.js";
import type { CatalogEntry } from "../../domain/catalog-entry.js";
import type { Attachment } from "../../domain/attachment.js";

declare module "hono" {
  interface ContextVariableMap {
    workspaceId: string;
    userId: string | null;
    agentKind: "worker" | "orchestrator" | "scheduled";
    /**
     * Resolved by the composition layer's requireAgentWrite middleware
     * from the workspace's `oauthMcpsOnOrchestrators` setting.
     * `true` when the policy is `on_attended` or `on`, `false` when
     * `off`. Routes use it to decide whether attaching a remote_oauth
     * MCP to a non-worker agent is allowed.
     */
    workspaceAllowsOauthOnNonWorkers: boolean;
  }
}

export interface CatalogRoutesConfig {
  catalog: CatalogService;
  requireAuth: MiddlewareHandler;
}

export interface AttachmentRoutesConfig {
  attachments: AttachmentService;
  requireAuth: MiddlewareHandler;
  /** Read gate: any workspace member can list attachments. */
  requireAgentRead: MiddlewareHandler;
  /** Write gate: admin/owner only — mutations also need agentKind + oauth policy in ctx. */
  requireAgentWrite: MiddlewareHandler;
}

function entryToJson(e: CatalogEntry) {
  return {
    id: e.id,
    name: e.name as string,
    display_name: e.displayName,
    kind: e.kind,
    image: e.image,
    command: e.command,
    args: e.args,
    url: e.url,
    // We don't expose the cached oauth_authorization_server metadata
    // to the workspace UI — internal use only at session-launch.
    manifest: e.manifest,
    description: e.description,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
    created_by: e.createdBy,
  };
}

// Strip literal values out of the wire response. `kind: "secret"` keeps
// its ref (the workspace_secrets *name* — useful for the edit UI and
// not itself sensitive). `kind: "value"` returns an empty string in
// place of the user-supplied literal so the api never echoes back
// configuration values that might (well-formed manifest or not) carry
// sensitive data. The frontend already renders kind:value as "•••" and
// pre-fills the edit form from local state, not from this payload —
// nothing client-side reads `value.value`. Session-launch resolution
// happens in-process via repository reads, never through this route.
function redactEnvJson(
  env: Record<string, { kind: string; value?: string; ref?: string }>,
): Record<string, { kind: string; value?: string; ref?: string }> {
  const out: Record<string, { kind: string; value?: string; ref?: string }> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v.kind === "secret") {
      out[k] = { kind: "secret", ref: v.ref };
    } else {
      out[k] = { kind: "value", value: "" };
    }
  }
  return out;
}

function attachmentToJson(a: Attachment) {
  return {
    id: a.id,
    agent_id: a.agentId,
    catalog_entry_id: a.catalogEntryId,
    env_json: redactEnvJson(
      a.envJson as unknown as Record<
        string,
        { kind: string; value?: string; ref?: string }
      >,
    ),
    tool_scopes_granted: a.toolScopesGranted,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
    created_by: a.createdBy,
  };
}

/**
 * Workspace MCP catalog CRUD. Mounted at
 *   /api/workspaces/:slug/mcp-catalog
 *
 * Same admin-only gate as workspace_secrets — knowing what catalog
 * entries exist (and their images / manifests) is privileged because
 * it leaks the integrations the workspace operates against.
 */
export function createMcpCatalogRoutes(cfg: CatalogRoutesConfig): Hono {
  const app = new Hono();

  app.use("*", cfg.requireAuth);
  app.use("*", async (c, next) => {
    const session = c.get("session") as
      | {
          email: string;
          userId: string | null;
          memberships: readonly { slug: string; workspaceId: string; role: string }[];
        }
      | undefined;
    if (!session?.email) return c.json({ error: "unauthenticated" }, 401);
    const slug = c.req.param("slug");
    if (!slug) return c.json({ error: "missing workspace slug" }, 400);
    const m = session.memberships.find((x) => x.slug === slug);
    if (!m) return c.json({ error: "forbidden" }, 403);
    if (m.role !== "admin" && m.role !== "owner") {
      return c.json({ error: "forbidden" }, 403);
    }
    c.set("workspaceId", m.workspaceId);
    c.set("userId", session.userId);
    await next();
  });

  app.get("/", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const items = await cfg.catalog.list(workspaceId);
    return c.json({ entries: items.map(entryToJson) });
  });

  app.get("/:id", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const id = c.req.param("id") ?? "";
    const entry = await cfg.catalog.get(workspaceId, id);
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(entryToJson(entry));
  });

  // PUT is upsert by name. Pass either no `id` (create / update by name)
  // or `id` (update existing — name still load-bearing as the conflict key).
  app.put("/", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const userId = c.get("userId") as string | null;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    try {
      const kind =
        body.kind === "remote_oauth" ? "remote_oauth" : "stdio";
      const entry = await cfg.catalog.set({
        workspaceId,
        name: typeof body.name === "string" ? body.name : "",
        displayName:
          typeof body.display_name === "string" ? body.display_name : null,
        kind,
        image: typeof body.image === "string" ? body.image : null,
        command: typeof body.command === "string" ? body.command : null,
        args:
          Array.isArray(body.args) && body.args.every((a) => typeof a === "string")
            ? (body.args as string[])
            : [],
        url: typeof body.url === "string" ? body.url : null,
        manifest: body.manifest,
        description:
          typeof body.description === "string" ? body.description : "",
        createdBy: userId,
      });
      return c.json(entryToJson(entry));
    } catch (err) {
      const e = err as { field?: string; message?: string };
      if (e.field) return c.json({ error: e.message, field: e.field }, 400);
      throw err;
    }
  });

  app.delete("/:id", async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const id = c.req.param("id") ?? "";
    const removed = await cfg.catalog.delete(workspaceId, id);
    if (!removed) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

/**
 * Per-agent MCP attachments. Mounted at
 *   /api/workspaces/:slug/agents/:agentId/mcp-attachments
 *
 * The composition layer provides two agent guards: `requireAgentRead`
 * (any workspace member) for GETs so the agent detail page can render
 * its configuration view, and `requireAgentWrite` (admin/owner) for
 * mutations. Both re-check that :agentId belongs to the URL workspace.
 */
export function createAgentMcpAttachmentRoutes(
  cfg: AttachmentRoutesConfig,
): Hono {
  const app = new Hono();

  app.use("*", cfg.requireAuth);

  app.get("/", cfg.requireAgentRead, async (c) => {
    const agentId = c.req.param("agentId") ?? "";
    const items = await cfg.attachments.list(agentId);
    return c.json({ attachments: items.map(attachmentToJson) });
  });

  app.put("/", cfg.requireAgentWrite, async (c) => {
    const workspaceId = c.get("workspaceId") as string;
    const userId = c.get("userId") as string | null;
    const agentId = c.req.param("agentId") ?? "";
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (typeof body.catalog_entry_id !== "string") {
      return c.json(
        { error: "catalog_entry_id is required", field: "catalog_entry_id" },
        400,
      );
    }
    // requireAgentWrite sets both unconditionally; if either is
    // missing the gate is mis-wired and we fail loud rather than
    // silently default to (worker, oauth=off) — that would silently
    // bypass the workspace's OAuth-on-orchestrator policy.
    const agentKind = c.get("agentKind") as
      | "worker"
      | "orchestrator"
      | "scheduled"
      | undefined;
    const workspaceAllowsOauthOnNonWorkers = c.get(
      "workspaceAllowsOauthOnNonWorkers",
    ) as boolean | undefined;
    if (agentKind === undefined || workspaceAllowsOauthOnNonWorkers === undefined) {
      throw new Error(
        "mcp-attachment PUT reached without agentKind/oauth policy in ctx — write guard mis-wired",
      );
    }
    try {
      const att = await cfg.attachments.attach({
        agentId,
        workspaceId,
        agentKind,
        workspaceAllowsOauthOnNonWorkers,
        catalogEntryId: body.catalog_entry_id,
        envJson:
          typeof body.env_json === "object" &&
          body.env_json !== null &&
          !Array.isArray(body.env_json)
            ? (body.env_json as Record<string, unknown>)
            : {},
        toolScopesGranted: Array.isArray(body.tool_scopes_granted)
          ? (body.tool_scopes_granted as string[])
          : undefined,
        createdBy: userId,
      });
      return c.json(attachmentToJson(att));
    } catch (err) {
      const e = err as { field?: string; message?: string };
      if (e.field) return c.json({ error: e.message, field: e.field }, 400);
      throw err;
    }
  });

  app.delete("/:id", cfg.requireAgentWrite, async (c) => {
    const agentId = c.req.param("agentId") ?? "";
    const id = c.req.param("id") ?? "";
    const removed = await cfg.attachments.detach(agentId, id);
    if (!removed) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
