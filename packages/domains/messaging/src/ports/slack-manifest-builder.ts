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
 *
 * `state` is baked into the redirect URL because Slack's "Install to
 * Workspace" button (the user-initiated install after the manifest
 * creates the app) does NOT add a `state` query parameter to the
 * OAuth round trip. Without state in the redirect URL itself, the
 * callback would receive `?code=...` only, with no way to look up
 * the bot config that initiated the flow.
 */
export interface SlackManifestBuilder {
  /** Magic link of the form `https://api.slack.com/apps?new_app=1&manifest_yaml=<encoded>`. */
  buildManifestUrl(input: { botName: SlackBotName; state: string }): string;
}
