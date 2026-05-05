import type { Context, Hono, MiddlewareHandler } from "hono";
import type postgres from "postgres";
import {
  decrypt,
  encrypt,
  type MasterKey,
} from "@x1agent/domain-workspace-secrets";
import {
  createSlackBotApiRoutes,
  createSlackEventsRoutes,
  createSlackOAuthRoutes,
  PostgresAgentWorkspaceReader,
  PostgresSlackBotConfigStore,
  PostgresSlackConnectedChannelStore,
  PostgresSlackInstallStateStore,
  PostgresSlackInstallStore,
  SlackHttpReplyClient,
  SlackManifestUrlBuilder,
  SlackOAuthHttpClient,
  type SlackTokenCipher,
} from "@x1agent/domain-messaging";
import type {
  Email,
  UserId,
  WorkspaceId,
} from "@x1agent/kernel";

export interface ComposeSlackEnv {
  /** Public URL of the api service (e.g. https://api.x1agent.com). */
  apiUrl: string;
  /** Public URL of the app (where the OAuth callback redirects to). */
  appUrl: string;
  sql: postgres.Sql<Record<string, unknown>>;
  /** Same key used by workspace_secrets — slack tokens use the same key
   *  to keep key management to a single concern. */
  workspaceSecretsKey: MasterKey;
  /** OAuth credentials for the platform Slack app. All three required
   *  for `configured` to be true; absent values turn the routes into
   *  stubs that report `slack_not_configured`. */
  platformClientId?: string;
  platformClientSecret?: string;
  platformSigningSecret?: string;
}

export interface ComposeSlackDeps {
  requireAuth: MiddlewareHandler;
  getActor: (c: Context) => { userId: UserId; email: Email } | null;
  /** (actor, workspace slug) → workspace id + canManage flag. Returns
   *  null if the actor is not a member of that workspace. */
  resolveWorkspace: (
    actor: UserId,
    slug: string,
  ) => Promise<{ id: WorkspaceId; canManage: boolean } | null>;
}

export interface ComposedSlack {
  oauthRoutes: Hono;
  botApiRoutes: Hono;
  /** /api/slack/events — Slack inbound event webhook. */
  eventsRoutes: Hono;
  configured: boolean;
}

/**
 * Adapter glue between domain ports and Node's crypto module. The
 * messaging package owns `SlackTokenCipher` as a port; this is the
 * concrete implementation backed by AES-256-GCM via the workspace
 * secrets cipher.
 */
function buildCipher(key: MasterKey): SlackTokenCipher {
  return {
    encrypt(plaintext: string) {
      const blob = encrypt(plaintext, key);
      return {
        ciphertext: blob.ciphertext,
        nonce: blob.nonce,
        authTag: blob.authTag,
      };
    },
    decrypt(blob) {
      return decrypt(
        {
          ciphertext: blob.ciphertext,
          nonce: blob.nonce,
          authTag: blob.authTag,
        },
        key,
      );
    },
  };
}

export function composeSlack(
  env: ComposeSlackEnv,
  deps: ComposeSlackDeps,
): ComposedSlack {
  const configured = Boolean(
    env.platformClientId &&
      env.platformClientSecret &&
      env.platformSigningSecret,
  );

  const cipher = buildCipher(env.workspaceSecretsKey);
  const configs = new PostgresSlackBotConfigStore(env.sql, cipher);
  const installs = new PostgresSlackInstallStore(env.sql, cipher);
  const state = new PostgresSlackInstallStateStore(env.sql);
  const agents = new PostgresAgentWorkspaceReader(env.sql);

  // Even when not configured, build the OAuth client and manifest
  // builder so the route handlers stay shaped consistently — the
  // routes themselves short-circuit on the `configured` flag.
  const oauth = new SlackOAuthHttpClient({
    clientId: env.platformClientId ?? "",
    clientSecret: env.platformClientSecret ?? "",
  });
  const manifest = new SlackManifestUrlBuilder({ apiPublicUrl: env.apiUrl });

  const callbackUrl = `${env.apiUrl}/oauth/slack/callback`;

  const routesConfig = {
    configs,
    installs,
    state,
    oauth,
    manifest,
    agents,
    appUrl: env.appUrl,
    callbackUrl,
    configured,
    requireAuth: deps.requireAuth,
    getActor: deps.getActor,
    resolveWorkspace: deps.resolveWorkspace,
  };

  // Channel registry lives behind the events handler — every channel
  // the bot is invited to gets a row, every leave clears it. The
  // settings UI reads via listByInstall.
  const channels = new PostgresSlackConnectedChannelStore(env.sql);
  const reply = new SlackHttpReplyClient();

  // v1 hooks. app_mention / message.im currently send a stub
  // acknowledgement so we can validate the round trip end-to-end on
  // production before wiring full agent invocation. The acknowledgement
  // includes the agent name when paired so users immediately see which
  // agent will handle their message.
  const eventsRoutes = createSlackEventsRoutes({
    configs,
    installs,
    onMemberJoinedChannel: async (ctx) => {
      const install = await installs.findByBotConfigAndTeam(
        ctx.botConfigId as never,
        ctx.slackTeamId as never,
      );
      if (!install) return;
      await channels.register({
        installId: install.id,
        channelId: ctx.channelId,
      });
    },
    onMemberLeftChannel: async (ctx) => {
      const install = await installs.findByBotConfigAndTeam(
        ctx.botConfigId as never,
        ctx.slackTeamId as never,
      );
      if (!install) return;
      await channels.markRemoved(install.id, ctx.channelId);
    },
    onAppMention: async (ctx) => {
      const ackText = ctx.agentId
        ? `Got it — passing this to the paired agent.`
        : `This bot isn't paired with an agent yet. A workspace admin needs to pair it from the agent edit page.`;
      // Auto-register the channel — first @ proves delivery works.
      const install = await installs.findByBotConfigAndTeam(
        ctx.botConfigId as never,
        ctx.slackTeamId as never,
      );
      if (install) {
        await channels.register({
          installId: install.id,
          channelId: ctx.channelId,
        });
      }
      await reply.postReply({
        botToken: ctx.botToken,
        channel: ctx.channelId,
        text: ackText,
        threadTs: ctx.threadTs ?? ctx.messageTs,
      });
    },
    onDirectMessage: async (ctx) => {
      const ackText = ctx.agentId
        ? `Got your DM — passing it to the paired agent.`
        : `This bot isn't paired with an agent yet.`;
      await reply.postReply({
        botToken: ctx.botToken,
        channel: ctx.channelId,
        text: ackText,
      });
    },
  });

  return {
    oauthRoutes: createSlackOAuthRoutes(routesConfig),
    botApiRoutes: createSlackBotApiRoutes(routesConfig),
    eventsRoutes,
    configured,
  };
}
