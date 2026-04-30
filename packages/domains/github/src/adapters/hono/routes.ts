import { Hono, type MiddlewareHandler, type Context } from "hono";
import { randomBytes } from "node:crypto";
import {
  DomainError,
  Email,
  type UserId,
} from "@x1agent/kernel";
import type { GitHubAppClient } from "../../ports/github-app-client.js";
import type { InstallationRepository } from "../../ports/installation-repository.js";
import type { AgentRepoStore } from "../../ports/agent-repo-store.js";
import { InstallationId } from "../../domain/installation.js";
import { recordInstallation } from "../../application/record-installation.js";
import { attachRepoToAgent } from "../../application/attach-repo-to-agent.js";
import { detachRepoFromAgent } from "../../application/detach-repo-from-agent.js";

export interface GitHubRoutesConfig {
  client: GitHubAppClient;
  installations: InstallationRepository;
  agentRepos: AgentRepoStore;

  /** Where to send the browser after a successful install. */
  appUrl: string;

  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;

  /**
   * Short-lived state token store (single-use; ~10min TTL). Defaults to
   * in-memory — for production or multi-instance dev, wire Postgres.
   */
  stateStore?: InstallStateStore;
}

export interface InstallStateStore {
  put(
    state: string,
    actor: UserId,
    expiresAt: Date,
    returnTo?: string | null,
  ): Promise<void>;
  consume(
    state: string,
  ): Promise<{ actor: UserId; returnTo: string | null } | null>;
}

export class InMemoryInstallStateStore implements InstallStateStore {
  private readonly rows = new Map<
    string,
    { actor: UserId; expiresAt: Date; returnTo: string | null }
  >();
  async put(state: string, actor: UserId, expiresAt: Date, returnTo = null) {
    this.rows.set(state, { actor, expiresAt, returnTo });
  }
  async consume(state: string) {
    const row = this.rows.get(state);
    if (!row) return null;
    this.rows.delete(state);
    if (row.expiresAt.getTime() < Date.now()) return null;
    return { actor: row.actor, returnTo: row.returnTo };
  }
}

/**
 * Only accept same-origin, absolute paths as return targets. This
 * prevents an open-redirect: an attacker-crafted `?return_to=https://evil.com`
 * would otherwise land the user on an attacker-controlled site after
 * a legitimate GitHub install. We require `/` leading + no `//` prefix
 * (which browsers treat as protocol-relative) + no `\` (Windows URL
 * parsing quirk).
 */
function safeReturnTo(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  return raw;
}

function errStatus(err: unknown): number {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "installation_not_found":
        return 404;
      case "installation_not_owned":
        return 403;
      case "repo_not_in_installation":
        return 404;
      case "repo_installation_mismatch":
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
  return { error: "internal_error", message: "unexpected failure" };
}

/**
 * `/auth/github/*` — browser-facing install redirect + GitHub App post-install
 * callback. GitHub App post-install redirects land on /auth/github/callback
 * with ?installation_id=... and the `state` we minted.
 */
export function createGitHubInstallRoutes(cfg: GitHubRoutesConfig): Hono {
  const app = new Hono();
  const store = cfg.stateStore ?? new InMemoryInstallStateStore();

  app.get("/install", cfg.requireAuth, async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const state = randomBytes(32).toString("hex");
    const returnTo = safeReturnTo(c.req.query("return_to"));
    await store.put(
      state,
      actor.userId,
      new Date(Date.now() + 10 * 60 * 1000),
      returnTo,
    );
    const url = new URL(
      `https://github.com/apps/${cfg.client.appSlug}/installations/new`,
    );
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/callback", async (c) => {
    const state = c.req.query("state");
    const installationIdStr = c.req.query("installation_id");
    // Default landing when no return_to was set on install. Same
    // fallback applies to every error branch below so the user always
    // ends up somewhere actionable rather than on a blank screen.
    const fallback = `${cfg.appUrl}/account`;
    if (!state || !installationIdStr)
      return c.redirect(`${fallback}?github_error=missing_params`);
    const consumed = await store.consume(state);
    if (!consumed)
      return c.redirect(`${fallback}?github_error=bad_state`);
    const target = consumed.returnTo
      ? `${cfg.appUrl}${consumed.returnTo}`
      : fallback;
    const separator = target.includes("?") ? "&" : "?";
    try {
      await recordInstallation(
        { client: cfg.client, installations: cfg.installations },
        {
          installationId: InstallationId(Number(installationIdStr)),
          actor: consumed.actor,
        },
      );
      return c.redirect(`${target}${separator}github_installed=1`);
    } catch (err) {
      return c.redirect(
        `${target}${separator}github_error=${
          err instanceof DomainError ? err.code : "install_failed"
        }`,
      );
    }
  });

  return app;
}

/**
 * `/api/installations/*` — JSON API consumed by the frontend.
 */
export function createInstallationApiRoutes(cfg: GitHubRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.get("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const rows = await cfg.installations.listByUser(actor.userId);
    return c.json({
      app_slug: cfg.client.appSlug,
      installations: rows.map((r) => ({
        id: r.id,
        installation_id: r.installationId,
        account_login: r.accountLogin,
        account_type: r.accountType,
        repository_selection: r.repositorySelection,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  app.get("/:installationId/repos", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const id = InstallationId(Number(c.req.param("installationId")));
    const row = await cfg.installations.findByInstallationId(id);
    if (!row || row.revokedAt)
      return c.json({ error: "installation_not_found" }, 404);
    if (row.installedByUserId !== actor.userId)
      return c.json({ error: "installation_not_owned" }, 403);
    const repos = await cfg.client.listInstallationRepos(id);
    return c.json({
      repos: repos.map((r) => ({
        full_name: r.fullName,
        id: r.id,
        default_branch: r.defaultBranch,
        private: r.private,
      })),
    });
  });

  return app;
}

/**
 * `/api/workspaces/:slug/agents/:agentId/repos` — attach/detach repos.
 * Workspace-role gating is handled by the composition wiring (same
 * admin guard the agents + invitations routes use).
 */
export function createAgentRepoRoutes(cfg: GitHubRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.get("/", async (c) => {
    const agentId = c.req.param("agentId")!;
    const repos = await cfg.agentRepos.listRepos(agentId);
    const installationId = await cfg.agentRepos.getLinkedInstallation(agentId);
    return c.json({
      installation_id: installationId ?? null,
      repos: repos.map((r) => ({
        repo_full_name: r.repoFullName,
        branch: r.branch,
        mount_path: r.mountPath,
        auto_push: r.autoPush,
        allow_push: r.allowPush,
      })),
    });
  });

  app.post("/", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      installation_id?: number;
      repo_full_name?: string;
      branch?: string;
      mount_path?: string;
      auto_push?: boolean;
      allow_push?: boolean;
    };
    if (!body.installation_id || !body.repo_full_name)
      return c.json({ error: "missing_fields" }, 400);
    try {
      await attachRepoToAgent(
        {
          client: cfg.client,
          installations: cfg.installations,
          agentRepos: cfg.agentRepos,
        },
        {
          actor: actor.userId,
          agentId: c.req.param("agentId")!,
          installationId: InstallationId(body.installation_id),
          repoFullName: body.repo_full_name,
          branch: body.branch,
          mountPath: body.mount_path,
          autoPush: body.auto_push,
          allowPush: body.allow_push,
        },
      );
      return c.json({ ok: true }, 201);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.patch("/:repoFullName{.+}", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      branch?: string;
      mount_path?: string;
      auto_push?: boolean;
      allow_push?: boolean;
    };
    try {
      await cfg.agentRepos.updateRepo(
        c.req.param("agentId")!,
        decodeURIComponent(c.req.param("repoFullName")!),
        {
          branch: body.branch,
          mountPath: body.mount_path,
          autoPush: body.auto_push,
          allowPush: body.allow_push,
        },
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
    // actor is parsed but workspace-admin gating is enforced by the
    // wrapping compose() — same as attach/detach.
    void actor;
  });

  app.delete("/:repoFullName{.+}", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    try {
      await detachRepoFromAgent(
        { agentRepos: cfg.agentRepos },
        {
          actor: actor.userId,
          agentId: c.req.param("agentId")!,
          repoFullName: decodeURIComponent(c.req.param("repoFullName")!),
        },
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
