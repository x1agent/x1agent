import type { SlackBotName } from "../../domain/slack-bot-config.js";
import type { SlackManifestBuilder } from "../../ports/slack-manifest-builder.js";

export interface SlackManifestUrlBuilderConfig {
  /** Public URL of the api service (e.g. `https://api.x1agent.com`). */
  apiPublicUrl: string;
  /** State token to include in the OAuth callback URL. */
  state?: string;
}

/** Default scopes for a per-bot Slack app. Explicit-invocation only.
 *  Ambient channel firehose scopes (channels:history, groups:history)
 *  are intentionally excluded — see architecture/slack-bots.md. */
const DEFAULT_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
];

/**
 * Builds the magic URL that opens Slack's app-creation flow with a
 * pre-filled YAML manifest. The manifest carries the bot name, the
 * scopes, the OAuth callback URL, and the event subscription URL.
 *
 * Slack accepts both YAML and JSON manifests; we use YAML because
 * Slack's docs and UI default to it and the line breaks make it easier
 * to debug if a user pastes the manifest into a support ticket.
 */
export class SlackManifestUrlBuilder implements SlackManifestBuilder {
  constructor(private readonly cfg: SlackManifestUrlBuilderConfig) {}

  buildManifestUrl(input: { botName: SlackBotName; state: string }): string {
    // State is baked into the redirect URL as a query param. Slack's
    // user-initiated "Install to Workspace" button does NOT inject a
    // `state` into the OAuth round trip — only an OAuth flow that we
    // initiate via api.slack.com/oauth/v2/authorize gets that. By
    // putting state in the redirect URL itself, Slack echoes it back
    // verbatim (and tacks `&code=...` onto the end), giving us a way
    // to look up the bot config from the callback. See P0 #1 in the
    // pre-push review of feat/slack-bot-onboarding.
    const callback = `${this.cfg.apiPublicUrl}/oauth/slack/callback?state=${encodeURIComponent(input.state)}`;
    const events = `${this.cfg.apiPublicUrl}/api/slack/events`;

    // Quote the bot name conservatively — even though Slack handles
    // most characters, YAML strings with colons or hashes need quotes.
    const safeName = JSON.stringify(input.botName);

    const yaml =
      `display_information:\n` +
      `  name: ${safeName}\n` +
      `  description: x1agent bot\n` +
      `features:\n` +
      `  bot_user:\n` +
      `    display_name: ${safeName}\n` +
      `    always_online: true\n` +
      `oauth_config:\n` +
      `  redirect_urls:\n` +
      `    - ${callback}\n` +
      `  scopes:\n` +
      `    bot:\n` +
      DEFAULT_BOT_SCOPES.map((s) => `      - ${s}\n`).join("") +
      `settings:\n` +
      `  event_subscriptions:\n` +
      `    request_url: ${events}\n` +
      `    bot_events:\n` +
      `      - app_mention\n` +
      `      - message.im\n` +
      `      - member_joined_channel\n` +
      `      - member_left_channel\n` +
      `  org_deploy_enabled: false\n` +
      `  socket_mode_enabled: false\n` +
      `  token_rotation_enabled: false\n`;

    const url = new URL("https://api.slack.com/apps");
    url.searchParams.set("new_app", "1");
    url.searchParams.set("manifest_yaml", yaml);
    return url.toString();
  }
}
