import {
  DomainError,
  ValidationError,
  type UserId,
  type WorkspaceId,
} from "@x1agent/kernel";

declare const slackBotConfigIdBrand: unique symbol;
export type SlackBotConfigId = string & {
  readonly [slackBotConfigIdBrand]: true;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SlackBotConfigId = (raw: string): SlackBotConfigId => {
  if (!UUID_RE.test(raw))
    throw new ValidationError("slack_bot_config_id", "must be a UUID");
  return raw.toLowerCase() as SlackBotConfigId;
};

declare const agentIdBrand: unique symbol;
export type AgentId = string & { readonly [agentIdBrand]: true };
export const AgentId = (raw: string): AgentId => {
  if (!UUID_RE.test(raw)) throw new ValidationError("agent_id", "must be a UUID");
  return raw.toLowerCase() as AgentId;
};

/**
 * The bot's display handle inside Slack. Slack itself enforces
 * per-team uniqueness on the display name; we additionally enforce
 * (workspace_id, bot_name) uniqueness so an x1agent workspace doesn't
 * track two configs with the same handle. Validation is intentionally
 * permissive — Slack accepts a wide range of handle characters and
 * will surface its own error at app-creation time if the manifest
 * uses an invalid one.
 */
declare const slackBotNameBrand: unique symbol;
export type SlackBotName = string & { readonly [slackBotNameBrand]: true };
export const SlackBotName = (raw: string): SlackBotName => {
  const trimmed = raw.trim();
  if (trimmed.length === 0)
    throw new ValidationError("bot_name", "must not be empty");
  if (trimmed.length > 80)
    throw new ValidationError("bot_name", "must be 80 chars or fewer");
  // Strip a leading @ if the user typed one, since the manifest carries
  // the bare name. "@triage" → "triage". Everything after the @ keeps
  // its original characters so the display name is preserved.
  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (normalized.length === 0)
    throw new ValidationError("bot_name", "must not be empty");
  return normalized as SlackBotName;
};

/**
 * Bot config row. Created when the user fills out the Add Bot form;
 * `slackAppId` and `slackBotUserId` are populated on the OAuth callback
 * after Slack creates the app and we exchange the install code.
 *
 * `agentId` is null until a workspace member pairs the bot from an
 * agent edit page. A bot can be paired with at most one agent, but
 * the constraint is enforced in the application layer (allowing
 * multiple bots-per-agent to remain a future option without a
 * migration).
 *
 * `hasSigningSecret` is the only signal callers need at the domain
 * level — the actual secret never leaves the store. The events
 * handler asks the store for the secret by app_id directly so it
 * never travels through the application layer in plaintext form.
 */
export interface SlackBotConfig {
  id: SlackBotConfigId;
  workspaceId: WorkspaceId;
  agentId: AgentId | null;
  botName: SlackBotName;
  slackAppId: string | null;
  slackBotUserId: string | null;
  hasSigningSecret: boolean;
  createdBy: UserId | null;
  createdAt: Date;
  updatedAt: Date;
}

export class SlackBotConfigNotFoundError extends DomainError {
  readonly code = "slack_bot_config_not_found";
  constructor(public readonly id: string) {
    super(`slack bot config ${id} not found`);
  }
}

export class SlackBotConfigNameTakenError extends DomainError {
  readonly code = "slack_bot_config_name_taken";
  constructor(public readonly botName: string) {
    super(`a bot named "${botName}" already exists in this workspace`);
  }
}

export class SlackBotConfigNotInWorkspaceError extends DomainError {
  readonly code = "slack_bot_config_not_in_workspace";
  constructor(
    public readonly id: string,
    public readonly workspaceId: string,
  ) {
    super(`slack bot config ${id} does not belong to workspace ${workspaceId}`);
  }
}

export class SlackBotAlreadyPairedError extends DomainError {
  readonly code = "slack_bot_already_paired";
  constructor(
    public readonly id: string,
    public readonly currentAgentId: string,
  ) {
    super(
      `slack bot ${id} is already paired with agent ${currentAgentId}; unpair first`,
    );
  }
}

/**
 * Thrown when a pair request names an agent that doesn't belong to the
 * caller's workspace. Treat at the same severity as "agent not found" —
 * we don't reveal whether the agent exists in another workspace, only
 * that it isn't usable from this one. See CLAUDE.md "Workspace tenant
 * isolation is sacred."
 */
export class SlackBotAgentNotInWorkspaceError extends DomainError {
  readonly code = "slack_bot_agent_not_in_workspace";
  constructor(
    public readonly agentId: string,
    public readonly workspaceId: string,
  ) {
    super(`agent ${agentId} is not in workspace ${workspaceId}`);
  }
}

export class SlackSigningSecretMissingError extends DomainError {
  readonly code = "slack_signing_secret_missing";
  constructor(public readonly slackAppId: string) {
    super(
      `no signing secret on file for slack app ${slackAppId}; cannot verify inbound event`,
    );
  }
}

export class SlackSigningSecretInvalidError extends DomainError {
  readonly code = "slack_signing_secret_invalid";
  constructor(reason: string) {
    super(`slack signing secret invalid: ${reason}`);
  }
}
