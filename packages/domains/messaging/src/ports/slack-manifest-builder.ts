import type { SlackBotName } from "../domain/slack-bot-config.js";

/**
 * Builds the Slack app manifest URL that the user clicks to spawn a
 * new per-bot Slack app. The manifest carries the bot name, the
 * scopes the bot needs, the OAuth callback URL on the platform, and
 * the request URL the bot's events will land on.
 *
 * Implementations are pure: a URL string in, a URL string out, no I/O.
 * Kept behind a port so the manifest content can be regenerated under
 * test without standing up a Slack app.
 */
export interface SlackManifestBuilder {
  /** Magic link of the form `https://api.slack.com/apps?new_app=1&manifest_yaml=<encoded>`. */
  buildManifestUrl(input: { botName: SlackBotName }): string;
}
