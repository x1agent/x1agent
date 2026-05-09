import { Hono, type Context, type MiddlewareHandler } from "hono";
import { randomBytes } from "node:crypto";
import {
  DomainError,
  type Email,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";
import { createSlackBotConfig } from "../../application/create-slack-bot-config.js";
import { recordSlackInstall } from "../../application/record-slack-install.js";
import {
  pairSlackBot,
  unpairSlackBot,
} from "../../application/pair-slack-bot.js";
import {
  AgentId,
  SlackBotConfigId,
} from "../../domain/slack-bot-config.js";
import type { SlackBotConfigStore } from "../../ports/slack-bot-config-store.js";
import type { SlackInstallStore } from "../../ports/slack-install-store.js";
import type { SlackInstallStateStore } from "../../ports/slack-install-state-store.js";
import type { SlackInstallCompleter } from "../../ports/slack-install-completer.js";
import type { SlackOAuthClient } from "../../ports/slack-oauth-client.js";
import type { SlackManifestBuilder } from "../../ports/slack-manifest-builder.js";
import type { AgentWorkspaceReader } from "../../ports/agent-workspace-reader.js";

export interface SlackRoutesConfig {
  configs: SlackBotConfigStore;
  installs: SlackInstallStore;
  state: SlackInstallStateStore;
  /** Atomic two-write boundary used by the OAuth callback. */
  completer: SlackInstallCompleter;
  oauth: SlackOAuthClient;
  manifest: SlackManifestBuilder;
  /** Resolves agent_id → workspace_id for tenant-isolation checks. */
  agents: AgentWorkspaceReader;

  /** Where to send the browser after a successful install (e.g. `https://app.x1agent.com`). */
  appUrl: string;
  /** OAuth callback URL given to Slack. Must match what's in the manifest. */
  callbackUrl: string;
  /**
   * True when the api has the platform-app credentials wired (client id,
   * client secret, signing secret). False until the operator runs the
   * configurator. Routes return `slack_not_configured` when false rather
   * than crashing on the OAuth code exchange.
   */
  configured: boolean;

  /** Auth + workspace gate middleware. Mirrors the github routes shape. */
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
  /**
   * Resolve a workspace slug → WorkspaceId, with a permission check.
   * Returns null when the actor isn't a member or the workspace doesn't
   * exist; the route returns 403 in either case.
   */
  resolveWorkspace: (
    actor: UserId,
    slug: string,
  ) => Promise<{ id: WorkspaceId; canManage: boolean } | null>;
}

/**
 * Validate a same-origin return path. Rejects anything that could
 * cause an open-redirect once concatenated onto the app URL:
 *   - non-leading slash (`evil.com/...`)
 *   - protocol-relative (`//evil.com/...`)
 *   - backslash-prefixed (`/\\evil.com` — some browsers treat as `//`)
 *   - percent-encoded variants of the above (`%2F%2F`, `%5C…`)
 *   - control / whitespace prefixes
 */
function safeReturnTo(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (raw.length > 512) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Decode-then-recheck: catches percent-encoded `//`, `/\\`, and any
  // other ambiguous prefix. We intentionally only check the first
  // few characters after decoding — we don't need to whitelist the
  // whole string, just block injection at the prefix.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded !== raw && (decoded.startsWith("//") || decoded.startsWith("/\\")))
    return null;
  // Reject any control character or whitespace anywhere in the path —
  // belt for prefix-trick attempts that smuggle CR/LF/etc.
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  return raw;
}

// Maps known domain errors to HTTP status. Unknown errors are
// rethrown so Hono's app.onError fires (→ Sentry.captureException).
function errStatus(err: unknown): number {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "slack_bot_config_not_found":
        return 404;
      // Tenant isolation: 404 (not 403) so the response doesn't
      // reveal whether the bot exists in another workspace. Same
      // treatment as the agent-not-in-workspace case below.
      case "slack_bot_config_not_in_workspace":
        return 404;
      case "slack_bot_agent_not_in_workspace":
        return 404;
      case "slack_bot_already_paired":
        return 409;
      case "slack_bot_agent_already_paired":
        return 409;
      case "slack_bot_config_name_taken":
        return 409;
      case "slack_install_attempt_invalid":
        return 400;
      default:
        return 400;
    }
  }
  throw err;
}

function errBody(err: unknown) {
  if (err instanceof DomainError)
    return { error: err.code, message: err.message };
  return { error: "internal_error", message: "unexpected failure" };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: string | null | undefined): boolean {
  return !!s && UUID_RE.test(s);
}

/**
 * Slack signing secrets are 32 hex characters per Slack's spec
 * (Basic Information → App Credentials). Anything else is almost
 * certainly a paste error — surface immediately rather than letting
 * 401 retry-loops bury the issue.
 */
const SIGNING_SECRET_RE = /^[0-9a-f]{32}$/i;

interface SlackInstallShape {
  id: string;
  slack_team_id: string;
  slack_team_name: string | null;
  installed_at: string;
}

/**
 * Bot config → wire DTO. The `installs` field is always present on the
 * wire so the frontend's required-field type stays honest. List
 * endpoints (GET) pass the loaded installs through; mutation endpoints
 * (POST/DELETE) pass `[]` because their response shape doesn't include
 * a side-effect-y database join. Optimistic-update consumers in the
 * store are then safe to spread into the cache without the field
 * undefined-ing out.
 */
function configToDto(
  c: import("../../domain/slack-bot-config.js").SlackBotConfig,
  installs: SlackInstallShape[] = [],
) {
  return {
    id: c.id as string,
    workspace_id: c.workspaceId as string,
    agent_id: c.agentId,
    bot_name: c.botName as string,
    slack_app_id: c.slackAppId,
    slack_bot_user_id: c.slackBotUserId,
    has_signing_secret: c.hasSigningSecret,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
    installs,
  };
}

/** `/oauth/slack/*` — browser-facing OAuth callback. */
export function createSlackOAuthRoutes(cfg: SlackRoutesConfig): Hono {
  const app = new Hono();

  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const slackError = c.req.query("error");
    const fallback = `${cfg.appUrl}/account`;
    if (slackError)
      return c.redirect(`${fallback}?slack_error=${encodeURIComponent(slackError)}`);
    if (!code || !state)
      return c.redirect(`${fallback}?slack_error=missing_params`);
    if (!cfg.configured)
      return c.redirect(`${fallback}?slack_error=not_configured`);

    try {
      const result = await recordSlackInstall(
        {
          oauth: cfg.oauth,
          configs: cfg.configs,
          completer: cfg.completer,
          state: cfg.state,
        },
        { state, code, redirectUri: cfg.callbackUrl },
      );
      const target = result.returnTo
        ? `${cfg.appUrl}${result.returnTo}`
        : fallback;
      const sep = target.includes("?") ? "&" : "?";
      return c.redirect(`${target}${sep}slack_installed=1`);
    } catch (err) {
      const code = err instanceof DomainError ? err.code : "install_failed";
      return c.redirect(`${fallback}?slack_error=${encodeURIComponent(code)}`);
    }
  });

  return app;
}

/** `/api/workspaces/:slug/slack/*` — JSON API consumed by the frontend. */
export function createSlackBotApiRoutes(cfg: SlackRoutesConfig): Hono {
  const app = new Hono();
  app.use("*", cfg.requireAuth);

  app.get("/bots", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const ws = await cfg.resolveWorkspace(actor.userId, c.req.param("slug")!);
    if (!ws) return c.json({ error: "forbidden" }, 403);
    try {
      const rows = await cfg.configs.listByWorkspace(ws.id);
      const installsByConfig = await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          installs: await cfg.installs.listByBotConfig(r.id),
        })),
      );
      const installMap = new Map(
        installsByConfig.map((x) => [x.id as string, x.installs]),
      );
      return c.json({
        configured: cfg.configured,
        bots: rows.map((r) =>
          configToDto(
            r,
            (installMap.get(r.id as string) ?? []).map((i) => ({
              id: i.id as string,
              slack_team_id: i.slackTeamId as string,
              slack_team_name: i.slackTeamName,
              installed_at: i.installedAt.toISOString(),
            })),
          ),
        ),
      });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 500);
    }
  });

  app.post("/bots", async (c) => {
    if (!cfg.configured)
      return c.json({ error: "slack_not_configured" }, 400);
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const ws = await cfg.resolveWorkspace(actor.userId, c.req.param("slug")!);
    if (!ws || !ws.canManage) return c.json({ error: "forbidden" }, 403);

    let body: { bot_name?: string; return_to?: string };
    try {
      body = (await c.req.json()) as { bot_name?: string; return_to?: string };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body.bot_name) return c.json({ error: "missing_fields" }, 400);

    try {
      const result = await createSlackBotConfig(
        {
          configs: cfg.configs,
          state: cfg.state,
          manifest: cfg.manifest,
          randomState: () => randomBytes(32).toString("hex"),
          now: () => new Date(),
        },
        {
          workspaceId: ws.id,
          rawBotName: body.bot_name,
          actor: actor.userId,
          returnTo: safeReturnTo(body.return_to) ?? undefined,
        },
      );
      // The manifest URL Slack opens carries the bot name + scopes; the
      // browser still has to round-trip through Slack and back. We hand
      // the URL + state token back so the caller can stash the state in
      // the row + open the URL in a new tab.
      return c.json(
        {
          bot: configToDto(result.config),
          manifest_url: result.manifestUrl,
          state: result.state,
        },
        201,
      );
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.delete("/bots/:id", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const ws = await cfg.resolveWorkspace(actor.userId, c.req.param("slug")!);
    if (!ws || !ws.canManage) return c.json({ error: "forbidden" }, 403);
    const idRaw = c.req.param("id")!;
    if (!isValidUuid(idRaw)) return c.json({ error: "invalid_id" }, 400);
    const id = SlackBotConfigId(idRaw);
    const existing = await cfg.configs.findById(id);
    if (!existing || existing.workspaceId !== ws.id)
      return c.json({ error: "slack_bot_config_not_found" }, 404);
    try {
      await cfg.configs.delete(id);
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 500);
    }
    return c.json({ ok: true });
  });

  app.post("/bots/:id/pair", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const ws = await cfg.resolveWorkspace(actor.userId, c.req.param("slug")!);
    if (!ws || !ws.canManage) return c.json({ error: "forbidden" }, 403);
    const idRaw = c.req.param("id")!;
    if (!isValidUuid(idRaw)) return c.json({ error: "invalid_id" }, 400);
    let body: { agent_id?: string };
    try {
      body = (await c.req.json()) as { agent_id?: string };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body.agent_id || !isValidUuid(body.agent_id))
      return c.json({ error: "missing_or_invalid_agent_id" }, 400);
    try {
      const result = await pairSlackBot(
        { configs: cfg.configs, agents: cfg.agents },
        {
          botConfigId: SlackBotConfigId(idRaw),
          workspaceId: ws.id,
          agentId: AgentId(body.agent_id),
        },
      );
      return c.json({ bot: configToDto(result) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.post("/bots/:id/signing-secret", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const ws = await cfg.resolveWorkspace(actor.userId, c.req.param("slug")!);
    if (!ws || !ws.canManage) return c.json({ error: "forbidden" }, 403);
    const idRaw = c.req.param("id")!;
    if (!isValidUuid(idRaw)) return c.json({ error: "invalid_id" }, 400);
    const id = SlackBotConfigId(idRaw);
    const existing = await cfg.configs.findById(id);
    if (!existing || existing.workspaceId !== ws.id)
      return c.json({ error: "slack_bot_config_not_found" }, 404);
    let body: { signing_secret?: string };
    try {
      body = (await c.req.json()) as { signing_secret?: string };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const plaintext = body.signing_secret?.trim() ?? "";
    if (!SIGNING_SECRET_RE.test(plaintext))
      return c.json({ error: "invalid_signing_secret" }, 400);
    try {
      const updated = await cfg.configs.recordSigningSecret({
        id,
        plaintext,
      });
      return c.json({ bot: configToDto(updated) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  app.delete("/bots/:id/pair", async (c) => {
    const actor = cfg.getActor(c);
    if (!actor) return c.json({ error: "unauthenticated" }, 401);
    const ws = await cfg.resolveWorkspace(actor.userId, c.req.param("slug")!);
    if (!ws || !ws.canManage) return c.json({ error: "forbidden" }, 403);
    const idRaw = c.req.param("id")!;
    if (!isValidUuid(idRaw)) return c.json({ error: "invalid_id" }, 400);
    try {
      const result = await unpairSlackBot(
        { configs: cfg.configs, agents: cfg.agents },
        {
          botConfigId: SlackBotConfigId(idRaw),
          workspaceId: ws.id,
        },
      );
      return c.json({ bot: configToDto(result) });
    } catch (err) {
      return c.json(errBody(err), errStatus(err) as 400);
    }
  });

  return app;
}
