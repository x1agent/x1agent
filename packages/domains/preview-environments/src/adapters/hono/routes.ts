import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  DomainError,
  Email,
  UserId,
  WorkspaceSlug,
  type WorkspaceId,
} from "@x1agent/kernel";
import {
  PreviewEnvironmentId,
  InvalidAliasHostError,
  isValidAliasHost,
  type PreviewEnvironment,
} from "../../domain/preview-environment.js";
import {
  PreviewEnvironmentNotFoundError,
  PreviewEnvironmentNotInWorkspaceError,
  PreviewSlugTakenError,
} from "../../domain/errors.js";
import type { PreviewEnvironmentRepository } from "../../ports/preview-environment-repository.js";
import {
  getPreviewEnvironmentById,
  getPreviewEnvironmentBySlug,
} from "../../application/get-preview-environment.js";
import { listPreviewEnvironments } from "../../application/list-preview-environments.js";

/**
 * Workspace-scoped read + admin-mutation surface for durable preview
 * environments. Mount point:
 *   /api/workspaces/:slug/preview-environments
 *
 * Routes:
 *   GET    /                 list every env in this workspace
 *   GET    /:id              one env (by id)
 *   GET    /by-slug/:slug    one env (by slug — env slug, not workspace slug)
 *   PATCH  /:id              rename (admin only)
 *   DELETE /:id              delete (admin only)
 *
 * Creation is NOT exposed here — environments come into existence via
 * the internal preview-deploy flow (the upsert use case is called by
 * the api when the agent invokes `preview_deploy`).
 */

export interface PreviewEnvironmentRoutesConfig {
  repository: PreviewEnvironmentRepository;
  /**
   * AdminGuard mirrors the shape used in the agents/workspaces routes —
   * called with the actor's workspace_id + user_id; throws on non-admin.
   */
  adminGuard: {
    requireWorkspaceAdmin: (
      workspaceId: WorkspaceId,
      userId: UserId,
    ) => Promise<void>;
  };
  resolveWorkspace: (slug: WorkspaceSlug) => Promise<WorkspaceId | null>;
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
  /**
   * Fires `x1.provider.preview.teardown` with the env's slug before the
   * row is dropped, so the provider removes the cluster Deployment /
   * Service / Ingress / Secret. When absent, DELETE drops the row only
   * and leaves the K8s resources dangling.
   */
  natsConnection?: import("nats").NatsConnection;
  /**
   * Hostnames an operator MUST NOT be able to register as an alias —
   * the install's own base domain, the preview domain, and any other
   * platform-controlled hostnames.
   *
   * Without this gate, a workspace admin could claim
   * `victim-slug.preview.<install>` (collide with another workspace's
   * preview), or `api.<install>` / `app.<install>` (intercept platform
   * traffic via Ingress host matching). Strictly server-side: the API
   * rejects the alias, no provider call ever happens.
   *
   * Rule per suffix `S`: reject `host === S` AND `host endsWith "." + S`.
   * Pass the install's apex (e.g. `x1agent.atomic.health`) and any
   * additional reserved domains (e.g. preview domain) — both are
   * covered by the suffix check.
   */
  forbiddenAliasSuffixes?: readonly string[];
}

function serialize(e: PreviewEnvironment) {
  return {
    id: e.id,
    workspace_id: e.workspaceId,
    slug: e.slug,
    title: e.title,
    repo_full_name: e.repoFullName,
    branch: e.branch,
    last_deploy_sha: e.lastDeploySha,
    last_deploy_url: e.lastDeployUrl,
    last_deploy_image_ref: e.lastDeployImageRef,
    last_deploy_status: e.lastDeployStatus,
    last_deploy_status_reason: e.lastDeployStatusReason,
    last_deploy_at: e.lastDeployAt?.toISOString() ?? null,
    env_var_names: e.envVarNames,
    alias_hosts: e.aliasHosts,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
  };
}

function errStatus(err: unknown): number {
  if (err instanceof PreviewEnvironmentNotFoundError) return 404;
  if (err instanceof PreviewEnvironmentNotInWorkspaceError) return 404;
  if (err instanceof PreviewSlugTakenError) return 409;
  if (err instanceof InvalidAliasHostError) return 400;
  if (err instanceof DomainError) {
    if (err.code === "admin_denied" || err.code === "not_a_member") return 403;
    if (err.code === "validation_error" || err.code === "invalid_preview_slug")
      return 400;
    return 400;
  }
  throw err;
}

function errBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

export function createPreviewEnvironmentRoutes(
  cfg: PreviewEnvironmentRoutesConfig,
): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  const resolveWs = async (slug: string) => {
    try {
      return await cfg.resolveWorkspace(WorkspaceSlug(slug));
    } catch {
      return null;
    }
  };

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const rows = await listPreviewEnvironments(
      { repository: cfg.repository },
      wsId,
    );
    return c.json({ preview_environments: rows.map(serialize) });
  });

  // GET /by-slug/:envSlug — declared before /:id so the literal path
  // wins the route match over the param.
  app.get("/by-slug/:envSlug", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      const env = await getPreviewEnvironmentBySlug(
        { repository: cfg.repository },
        wsId,
        c.req.param("envSlug")!,
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.get("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    try {
      const env = await getPreviewEnvironmentById(
        { repository: cfg.repository },
        wsId,
        PreviewEnvironmentId(c.req.param("id")!),
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  // Replace the env-var-names list (workspace-scoped bindings the env
  // wants injected at deploy time). Admin-only.
  app.put("/:id/env-vars", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      env_var_names?: unknown;
    };
    if (!Array.isArray(body.env_var_names)) {
      return c.json(
        { error: "missing_fields", message: "env_var_names must be an array" },
        400,
      );
    }
    try {
      await cfg.adminGuard.requireWorkspaceAdmin(wsId, actor.userId);
      const env = await cfg.repository.setEnvVarNames(
        PreviewEnvironmentId(c.req.param("id")!),
        wsId,
        body.env_var_names.filter(
          (x): x is string => typeof x === "string",
        ),
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  // Replace the alias-hosts list (vanity domains the preview should
  // also answer on). Admin-only. Each entry is validated against
  // RFC 1123 hostname rules; first invalid entry rejects the whole
  // call. Operators are expected to CNAME each host at the cluster
  // ingress before adding it here.
  app.put("/:id/alias-hosts", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      alias_hosts?: unknown;
    };
    if (!Array.isArray(body.alias_hosts)) {
      return c.json(
        { error: "missing_fields", message: "alias_hosts must be an array" },
        400,
      );
    }
    const forbiddenSuffixes = (cfg.forbiddenAliasSuffixes ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    const isForbidden = (host: string): string | null => {
      for (const s of forbiddenSuffixes) {
        if (host === s || host.endsWith("." + s)) return s;
      }
      return null;
    };
    const normalized: string[] = [];
    for (const raw of body.alias_hosts) {
      if (typeof raw !== "string") {
        return c.json(
          { error: "missing_fields", message: "alias_hosts must be strings" },
          400,
        );
      }
      const v = raw.trim().toLowerCase();
      if (v === "") continue;
      if (!isValidAliasHost(v)) {
        return c.json(errBody(new InvalidAliasHostError(raw)), 400);
      }
      const collidesWith = isForbidden(v);
      if (collidesWith) {
        // Hard refuse: the install's base/preview domain (or any
        // explicitly-reserved domain) can never be claimed as an
        // alias. Without this, a workspace admin could collide with
        // another workspace's preview slug or intercept platform
        // traffic via Ingress host matching.
        return c.json(
          {
            error: "alias_host_forbidden",
            message: `${v} is on the platform's reserved domain (${collidesWith}). Use a hostname you own.`,
          },
          400,
        );
      }
      normalized.push(v);
    }
    try {
      await cfg.adminGuard.requireWorkspaceAdmin(wsId, actor.userId);
      const env = await cfg.repository.setAliasHosts(
        PreviewEnvironmentId(c.req.param("id")!),
        wsId,
        normalized,
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.patch("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return c.json({ error: "missing_fields", message: "title required" }, 400);
    }
    try {
      await cfg.adminGuard.requireWorkspaceAdmin(wsId, actor.userId);
      const env = await cfg.repository.rename(
        PreviewEnvironmentId(c.req.param("id")!),
        wsId,
        body.title.trim(),
      );
      return c.json({ preview_environment: serialize(env) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.delete("/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const wsId = await resolveWs(c.req.param("slug")!);
    if (!wsId) return c.json({ error: "workspace_not_found" }, 404);
    const envId = PreviewEnvironmentId(c.req.param("id")!);
    try {
      await cfg.adminGuard.requireWorkspaceAdmin(wsId, actor.userId);
      // Read the env first so we know the slug to pass to the
      // provider's teardown. NotFound short-circuits to 404 before any
      // teardown attempt.
      const env = await getPreviewEnvironmentById(
        { repository: cfg.repository },
        wsId,
        envId,
      );

      // Tell the provider to delete the cluster Deployment / Service /
      // Ingress / Secret. Best-effort: if the NATS request fails, we
      // log + proceed to drop the row anyway. The alternative — leaving
      // a tombstone with K8s resources still up but no row — is a worse
      // half-state for the operator.
      if (cfg.natsConnection) {
        try {
          const { JSONCodec } = await import("nats");
          const jc = JSONCodec();
          await cfg.natsConnection.request(
            "x1.provider.preview.teardown",
            jc.encode({ slug: env.slug }),
            { timeout: 30_000 },
          );
        } catch (err) {
          console.warn(
            "[preview-environments] teardown NATS request failed:",
            (err as Error).message,
          );
        }
      }

      await cfg.repository.delete(envId, wsId);
      return c.body(null, 204);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
