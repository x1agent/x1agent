import type { UserId } from "@x1agent/kernel";
import type { SlackBotConfigId } from "../domain/slack-bot-config.js";

/**
 * Single-use OAuth state tokens. Minted by `/install/begin`, consumed
 * by `/install/callback`. State carries the bot config id (so the
 * callback knows which bot to write the install row for) and the
 * initiating user id (so the callback can re-check workspace
 * membership before persisting).
 *
 * `consume` returns null on missing, expired, or already-consumed
 * tokens. Callers cannot distinguish those cases — they all redirect
 * to the same error page. This is deliberate: leaking which one
 * applied would let an attacker enumerate state tokens.
 */
export interface SlackInstallStateStore {
  put(input: {
    state: string;
    botConfigId: SlackBotConfigId;
    initiatingUserId: UserId;
    expiresAt: Date;
    returnTo?: string | null;
  }): Promise<void>;

  consume(state: string): Promise<{
    botConfigId: SlackBotConfigId;
    initiatingUserId: UserId;
    returnTo: string | null;
  } | null>;
}
