import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type {
  AgentId,
  SlackBotConfig,
  SlackBotConfigId,
  SlackBotName,
} from "../domain/slack-bot-config.js";

/**
 * Persistence port for `slack_bot_configs`. Implementations: postgres
 * (production), in-memory (unit tests for application services).
 *
 * Pairing semantics:
 *   - `agentId` is null on creation; set via `pair`, cleared via `unpair`.
 *   - `pair` is allowed only when the bot is currently unpaired. The
 *     store itself doesn't enforce this — the application layer does,
 *     because the rule is a workspace-level invariant rather than a DB
 *     constraint (we want to permit future relaxation to N-bots-per-agent
 *     without a migration).
 */
export interface SlackBotConfigStore {
  findById(id: SlackBotConfigId): Promise<SlackBotConfig | null>;
  findByWorkspaceAndName(
    workspaceId: WorkspaceId,
    name: SlackBotName,
  ): Promise<SlackBotConfig | null>;
  findByAgent(agentId: AgentId): Promise<SlackBotConfig | null>;
  findBySlackAppId(slackAppId: string): Promise<SlackBotConfig | null>;

  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly SlackBotConfig[]>;

  create(input: {
    workspaceId: WorkspaceId;
    botName: SlackBotName;
    createdBy: UserId | null;
  }): Promise<SlackBotConfig>;

  /** Called from the OAuth callback once Slack has minted the app. */
  recordSlackAppDetails(input: {
    id: SlackBotConfigId;
    slackAppId: string;
    slackBotUserId: string;
  }): Promise<SlackBotConfig>;

  /**
   * Persist the signing secret for a bot. The store encrypts before
   * writing; plaintext is never stored on disk. Idempotent — calling
   * twice with the same plaintext leaves the row in the same logical
   * state (different ciphertext only because GCM nonce randomizes).
   */
  recordSigningSecret(input: {
    id: SlackBotConfigId;
    plaintext: string;
  }): Promise<SlackBotConfig>;

  /**
   * Resolve a Slack app id to its plaintext signing secret. Returns
   * null when the bot config is unknown or has no signing secret on
   * file yet (paste-back not completed). The events handler uses this
   * to verify the HMAC on each inbound event.
   *
   * Decryption happens inside the adapter via the cipher seam — the
   * application layer never sees the encrypted blob.
   */
  getSigningSecretByAppId(slackAppId: string): Promise<string | null>;

  pair(input: {
    id: SlackBotConfigId;
    agentId: AgentId;
  }): Promise<SlackBotConfig>;

  unpair(id: SlackBotConfigId): Promise<SlackBotConfig>;

  delete(id: SlackBotConfigId): Promise<void>;
}
