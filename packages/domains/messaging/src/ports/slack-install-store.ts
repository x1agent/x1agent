import type { UserId } from "@x1agent/kernel";
import type { SlackBotConfigId } from "../domain/slack-bot-config.js";
import type {
  SlackInstall,
  SlackInstallId,
  SlackTeamId,
} from "../domain/slack-install.js";

/**
 * Persistence port for `slack_installs`. The store handles bot-token
 * encryption and decryption internally — callers always see plaintext
 * via `botToken` on the returned `SlackInstall`. The on-disk column
 * stays encrypted at rest; encryption is wired by the composition root
 * (api startup) and injected into the store implementation.
 */
export interface SlackInstallStore {
  findById(id: SlackInstallId): Promise<SlackInstall | null>;

  findByBotConfigAndTeam(
    botConfigId: SlackBotConfigId,
    teamId: SlackTeamId,
  ): Promise<SlackInstall | null>;

  /** Active (non-revoked) installs for a bot config. */
  listByBotConfig(
    botConfigId: SlackBotConfigId,
  ): Promise<readonly SlackInstall[]>;

  /** Lookup by app + team — used by the inbound event handler to route. */
  findByAppAndTeam(
    slackAppId: string,
    teamId: SlackTeamId,
  ): Promise<SlackInstall | null>;

  /**
   * Insert or update an install row. Re-installing into the same Slack
   * team replaces the row (clears `revokedAt`, refreshes the token).
   */
  upsert(input: {
    botConfigId: SlackBotConfigId;
    slackTeamId: SlackTeamId;
    slackTeamName: string | null;
    botToken: string;
    installedByUserId: UserId | null;
  }): Promise<SlackInstall>;

  markRevoked(id: SlackInstallId, at: Date): Promise<void>;
}
