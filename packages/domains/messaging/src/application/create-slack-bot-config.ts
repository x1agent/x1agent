import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { SlackBotConfigStore } from "../ports/slack-bot-config-store.js";
import type { SlackInstallStateStore } from "../ports/slack-install-state-store.js";
import type { SlackManifestBuilder } from "../ports/slack-manifest-builder.js";
import {
  type SlackBotConfig,
  SlackBotConfigNameTakenError,
  SlackBotName,
} from "../domain/slack-bot-config.js";

export interface CreateSlackBotConfigDeps {
  configs: SlackBotConfigStore;
  state: SlackInstallStateStore;
  manifest: SlackManifestBuilder;
  /** Random hex-string generator. Injected for deterministic tests. */
  randomState: () => string;
  /** Returns "now" — injected for deterministic tests. */
  now: () => Date;
}

export interface CreateSlackBotConfigInput {
  workspaceId: WorkspaceId;
  rawBotName: string;
  actor: UserId;
  /** Optional same-origin path the OAuth callback should redirect back to. */
  returnTo?: string;
}

export interface CreateSlackBotConfigResult {
  config: SlackBotConfig;
  manifestUrl: string;
  /** State token. Caller (the route) sets it as a query param so Slack
   *  echoes it back on the callback. */
  state: string;
}

/** State token TTL for the per-bot install attempt — long enough for a
 *  leisurely OAuth round trip, short enough that a stolen token has
 *  almost no value. Same as the GitHub install flow. */
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Create a bot config row, mint an install-state token, and return the
 * Slack manifest URL the browser should open. The route handler does
 * the redirect itself; this use case stays I/O-light by handing the
 * URL back to the caller.
 *
 * Errors:
 *   - `SlackBotConfigNameTakenError` if a bot with the same name
 *     already exists in the workspace.
 */
export async function createSlackBotConfig(
  deps: CreateSlackBotConfigDeps,
  input: CreateSlackBotConfigInput,
): Promise<CreateSlackBotConfigResult> {
  const botName = SlackBotName(input.rawBotName);

  const existing = await deps.configs.findByWorkspaceAndName(
    input.workspaceId,
    botName,
  );
  if (existing) throw new SlackBotConfigNameTakenError(botName);

  const config = await deps.configs.create({
    workspaceId: input.workspaceId,
    botName,
    createdBy: input.actor,
  });

  const stateToken = deps.randomState();
  await deps.state.put({
    state: stateToken,
    botConfigId: config.id,
    initiatingUserId: input.actor,
    expiresAt: new Date(deps.now().getTime() + INSTALL_STATE_TTL_MS),
    returnTo: input.returnTo ?? null,
  });

  // State is baked into the manifest's redirect URL because Slack's
  // user-initiated install button does not propagate state through
  // OAuth. See `slack-manifest-builder.ts` for the full reasoning.
  const manifestUrl = deps.manifest.buildManifestUrl({
    botName,
    state: stateToken,
  });

  return { config, manifestUrl, state: stateToken };
}
