import { DomainError, ValidationError, type UserId } from "@x1agent/kernel";
import type { SlackBotConfigId } from "./slack-bot-config.js";

declare const slackInstallIdBrand: unique symbol;
export type SlackInstallId = string & {
  readonly [slackInstallIdBrand]: true;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SlackInstallId = (raw: string): SlackInstallId => {
  if (!UUID_RE.test(raw))
    throw new ValidationError("slack_install_id", "must be a UUID");
  return raw.toLowerCase() as SlackInstallId;
};

/**
 * Slack's team identifier. Always uppercase, prefixed `T` for normal
 * teams and `E` for Enterprise Grid orgs. We persist whatever Slack
 * returns; validation is just a non-empty check since the format isn't
 * formally guaranteed forever.
 */
declare const slackTeamIdBrand: unique symbol;
export type SlackTeamId = string & { readonly [slackTeamIdBrand]: true };
export const SlackTeamId = (raw: string): SlackTeamId => {
  // Trim defensively. Stray whitespace from a manual paste or a
  // Slack response with surrounding whitespace silently breaks
  // event lookups otherwise (the events handler does `WHERE
  // slack_team_id = $1` with no LIKE).
  const trimmed = raw.trim();
  if (trimmed.length === 0)
    throw new ValidationError("slack_team_id", "must not be empty");
  return trimmed as SlackTeamId;
};

/**
 * One row per (bot_config, slack_team). A given bot can be installed
 * into multiple Slack teams; each install is tracked separately so
 * channel registrations and bot tokens stay isolated by team.
 *
 * `botToken` is the encrypted form. The repository decrypts on read
 * via the secret-store binding the api wires at startup; the domain
 * layer never sees plaintext tokens.
 */
export interface SlackInstall {
  id: SlackInstallId;
  botConfigId: SlackBotConfigId;
  slackTeamId: SlackTeamId;
  slackTeamName: string | null;
  /** Decrypted bot token (xoxb-*). Loaded only on read by adapters that
   *  hold the decryption key. */
  botToken: string;
  installedByUserId: UserId | null;
  installedAt: Date;
  revokedAt: Date | null;
}

export class SlackInstallNotFoundError extends DomainError {
  readonly code = "slack_install_not_found";
  constructor(public readonly id: string) {
    super(`slack install ${id} not found`);
  }
}

export class SlackInstallAttemptInvalidError extends DomainError {
  readonly code = "slack_install_attempt_invalid";
  constructor(reason: string) {
    super(`slack install attempt invalid: ${reason}`);
  }
}
