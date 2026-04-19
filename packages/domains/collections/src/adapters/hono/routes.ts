import { Hono, type MiddlewareHandler } from "hono";
import {
  DomainError,
  WorkspaceSlug,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import { createCollection } from "../../application/create-collection.js";
import { deleteCollection } from "../../application/delete-collection.js";
import { updateCollection } from "../../application/update-collection.js";
import { listCollections } from "../../application/list-collections.js";
import { syncAgentAttachments } from "../../application/sync-agent-attachments.js";
import {
  CollectionId,
  CollectionProviderType,
  CollectionSlug,
  type Collection,
} from "../../domain/collection.js";
import type { CollectionRepository } from "../../ports/collection-repository.js";
import type { AdminGuard } from "../../ports/admin-guard.js";
import type { ProviderGateway } from "../../ports/provider-gateway.js";

export interface WorkspaceReader {
  getIdBySlug(slug: WorkspaceSlug): Promise<WorkspaceId | null>;
  /** Returns the slug for a given id — used to build backend_handle. */
  getSlugById(id: WorkspaceId): Promise<WorkspaceSlug | null>;
}

export interface CollectionRoutesConfig {
  collections: CollectionRepository;
  adminGuard: AdminGuard;
  providers: ProviderGateway;
  workspaces: WorkspaceReader;
  requireAuth: MiddlewareHandler;
  getActor: (
    c: Parameters<MiddlewareHandler>[0],
  ) => { userId: UserId; email: Email } | null;
}

function serializeCollection(c: Collection) {
  return {
    id: c.id,
    workspace_id: c.workspaceId,
    name: c.name,
    slug: c.slug,
    description: c.description,
    provider_type: c.providerType,
    backend_handle: c.backendHandle,
    settings: c.settings,
    created_by: c.createdBy,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

function errStatus(err: unknown): number {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "collection_not_found":
        return 404;
      case "collection_wrong_workspace":
      case "admin_denied":
      case "not_a_member":
      case "insufficient_role":
        return 403;
      case "collection_slug_taken":
        return 409;
      default:
        return 400;
    }
  }
  return 500;
}

function errBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return {
    error: "internal_error",
    message: (err as Error)?.message ?? "unexpected failure",
  };
}

/**
 * Workspace-scoped collection routes: /workspaces/:slug/collections.
 * GET is membership-gated; POST/PATCH/DELETE are admin-gated (the
 * application layer enforces it, but the middleware bucket stays
 * requireAuth so 401s come from missing cookies, not missing role).
 */
export function createCollectionRoutes(cfg: CollectionRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) => {
    try {
      return await cfg.workspaces.getIdBySlug(WorkspaceSlug(slug));
    } catch {
      return null;
    }
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const rows = await listCollections(
      { collections: cfg.collections },
      actor.userId,
      wsId,
    );
    return c.json({ collections: rows.map(serializeCollection) });
  });

  app.get("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const col = await cfg.collections.findById(
      CollectionId(c.req.param("id")!),
    );
    if (!col || col.workspaceId !== wsId)
      return c.json({ error: "collection_not_found" }, 404);
    return c.json({ collection: serializeCollection(col) });
  });

  // List records of a specific type. Membership-gated.
  app.get("/:id/record-types/:type/records", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const col = await cfg.collections.findById(
      CollectionId(c.req.param("id")!),
    );
    if (!col || col.workspaceId !== wsId)
      return c.json({ error: "collection_not_found" }, 404);
    const limit = Math.max(
      1,
      Math.min(500, Number(c.req.query("limit") ?? 100)),
    );
    try {
      const records = await cfg.providers.listRecords(
        col.providerType,
        col.backendHandle,
        c.req.param("type")!,
        limit,
      );
      return c.json({ records });
    } catch (err) {
      const e = err as Error & { code?: string };
      return c.json(
        {
          error: e.code ?? "provider_error",
          message: e.message ?? "listRecords failed",
        },
        502,
      );
    }
  });

  // Live provider query for the collection's record-type registry.
  // Membership-gated like the rest of the read surface.
  app.get("/:id/record-types", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const col = await cfg.collections.findById(
      CollectionId(c.req.param("id")!),
    );
    if (!col || col.workspaceId !== wsId)
      return c.json({ error: "collection_not_found" }, 404);
    try {
      const types = await cfg.providers.discover(col.providerType, col.backendHandle);
      return c.json({ record_types: types });
    } catch (err) {
      const e = err as Error & { code?: string };
      return c.json(
        {
          error: e.code ?? "provider_error",
          message: e.message ?? "discover failed",
        },
        502,
      );
    }
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const wsSlug = await cfg.workspaces.getSlugById(wsId);
    if (!wsSlug) return c.json({ error: "workspace_not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      slug?: string;
      description?: string | null;
      provider_type?: string;
      settings?: Record<string, unknown>;
    };
    if (!body.name || !body.slug)
      return c.json({ error: "missing_fields", need: ["name", "slug"] }, 400);

    try {
      const out = await createCollection(
        {
          collections: cfg.collections,
          adminGuard: cfg.adminGuard,
          providers: cfg.providers,
        },
        {
          actor: actor.userId,
          workspaceId: wsId,
          workspaceSlug: wsSlug,
          name: body.name,
          slug: CollectionSlug(body.slug),
          description: body.description ?? null,
          providerType: CollectionProviderType(
            body.provider_type ?? "surrealdb",
          ),
          settings: body.settings ?? {},
        },
      );
      return c.json({ collection: serializeCollection(out) }, 201);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.patch("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string | null;
      settings?: Record<string, unknown>;
    };
    try {
      const out = await updateCollection(
        { collections: cfg.collections, adminGuard: cfg.adminGuard },
        {
          actor: actor.userId,
          workspaceId: wsId,
          collectionId: CollectionId(c.req.param("id")!),
          patch: body,
        },
      );
      return c.json({ collection: serializeCollection(out) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      await deleteCollection(
        {
          collections: cfg.collections,
          adminGuard: cfg.adminGuard,
          providers: cfg.providers,
        },
        {
          actor: actor.userId,
          workspaceId: wsId,
          collectionId: CollectionId(c.req.param("id")!),
        },
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}

export interface AgentCollectionRoutesConfig {
  collections: CollectionRepository;
  adminGuard: AdminGuard;
  workspaces: WorkspaceReader;
  requireAuth: MiddlewareHandler;
  getActor: (
    c: Parameters<MiddlewareHandler>[0],
  ) => { userId: UserId; email: Email } | null;
}

/**
 * Agent ↔ collections attachments live under
 * /workspaces/:slug/agents/:agentId/collections.
 * GET lists current attachments (with is_default flag), PUT replaces
 * the whole set in one call — the UI card builds a checkboxed list
 * and POSTs the final desired state.
 */
export function createAgentCollectionRoutes(
  cfg: AgentCollectionRoutesConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) => {
    try {
      return await cfg.workspaces.getIdBySlug(WorkspaceSlug(slug));
    } catch {
      return null;
    }
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const agentId = AgentId(c.req.param("agentId")!);
    const rows = await cfg.collections.listCollectionsForAgent(agentId);
    return c.json({
      attachments: rows.map((r) => ({
        ...serializeCollection(r),
        is_default: r.isDefault,
      })),
    });
  });

  app.put("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      collection_ids?: string[];
      default_collection_id?: string | null;
    };
    if (!Array.isArray(body.collection_ids))
      return c.json({ error: "invalid_request" }, 400);

    try {
      await syncAgentAttachments(
        { collections: cfg.collections, adminGuard: cfg.adminGuard },
        {
          actor: actor.userId,
          workspaceId: wsId,
          agentId: AgentId(c.req.param("agentId")!),
          collectionIds: body.collection_ids.map((id) => CollectionId(id)),
          defaultCollectionId: body.default_collection_id
            ? CollectionId(body.default_collection_id)
            : null,
        },
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
