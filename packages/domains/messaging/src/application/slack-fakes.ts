import { randomUUID } from "node:crypto";
import type { UserId, WorkspaceId } from "@x1agent/kernel";
import type { AgentWorkspaceReader } from "../ports/agent-workspace-reader.js";
import {
  type AgentId,
  type SlackBotConfig,
  SlackBotConfigId,
  type SlackBotName,
} from "../domain/slack-bot-config.js";
import {
  type SlackInstall,
  SlackInstallId,
  type SlackTeamId,
} from "../domain/slack-install.js";
import type { SlackBotConfigStore } from "../ports/slack-bot-config-store.js";
import type { SlackInstallStateStore } from "../ports/slack-install-state-store.js";
import type { SlackInstallStore } from "../ports/slack-install-store.js";
import type { SlackInstallCompleter } from "../ports/slack-install-completer.js";
import type {
  SlackOAuthClient,
  SlackOAuthExchangeResult,
} from "../ports/slack-oauth-client.js";
import type { SlackManifestBuilder } from "../ports/slack-manifest-builder.js";

/**
 * In-memory `SlackBotConfigStore`. Tracks all writes, exposes the
 * underlying map for assertions. Safe to construct fresh per test.
 */
export class InMemorySlackBotConfigStore implements SlackBotConfigStore {
  readonly rows = new Map<string, SlackBotConfig>();
  /** Plaintext signing secrets keyed by config id. The fake holds them
   *  in plaintext; production goes through the cipher in the postgres
   *  adapter. Tests that need to verify the events handler can read
   *  this directly via getSigningSecretByAppId. */
  readonly signingSecretsById = new Map<string, string>();

  async findById(id: SlackBotConfigId) {
    return this.rows.get(id) ?? null;
  }

  async findByWorkspaceAndName(workspaceId: WorkspaceId, name: SlackBotName) {
    for (const r of this.rows.values()) {
      if (r.workspaceId === workspaceId && r.botName === name) return r;
    }
    return null;
  }

  async findByAgent(agentId: AgentId) {
    for (const r of this.rows.values()) {
      if (r.agentId === agentId) return r;
    }
    return null;
  }

  async findBySlackAppId(slackAppId: string) {
    for (const r of this.rows.values()) {
      if (r.slackAppId === slackAppId) return r;
    }
    return null;
  }

  async listByWorkspace(workspaceId: WorkspaceId) {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
  }

  async create(input: {
    workspaceId: WorkspaceId;
    botName: SlackBotName;
    createdBy: UserId | null;
  }) {
    const id = SlackBotConfigId(randomUUID());
    const now = new Date();
    const row: SlackBotConfig = {
      id,
      workspaceId: input.workspaceId,
      agentId: null,
      botName: input.botName,
      slackAppId: null,
      slackBotUserId: null,
      hasSigningSecret: false,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return row;
  }

  async recordSigningSecret(input: { id: SlackBotConfigId; plaintext: string }) {
    const existing = this.rows.get(input.id);
    if (!existing) throw new Error(`config ${input.id} not found`);
    this.signingSecretsById.set(input.id as string, input.plaintext);
    const updated: SlackBotConfig = {
      ...existing,
      hasSigningSecret: true,
      updatedAt: new Date(),
    };
    this.rows.set(input.id, updated);
    return updated;
  }

  async getSigningSecretByAppId(slackAppId: string) {
    for (const [id, row] of this.rows.entries()) {
      if (row.slackAppId === slackAppId) {
        return this.signingSecretsById.get(id) ?? null;
      }
    }
    return null;
  }

  async recordSlackAppDetails(input: {
    id: SlackBotConfigId;
    slackAppId: string;
    slackBotUserId: string;
  }) {
    const existing = this.rows.get(input.id);
    if (!existing) throw new Error(`config ${input.id} not found`);
    const updated: SlackBotConfig = {
      ...existing,
      slackAppId: input.slackAppId,
      slackBotUserId: input.slackBotUserId,
      // hasSigningSecret stays as-is; OAuth callback doesn't set it.
      updatedAt: new Date(),
    };
    this.rows.set(input.id, updated);
    return updated;
  }

  async pair(input: { id: SlackBotConfigId; agentId: AgentId }) {
    const existing = this.rows.get(input.id);
    if (!existing) throw new Error(`config ${input.id} not found`);
    const updated: SlackBotConfig = {
      ...existing,
      agentId: input.agentId,
      updatedAt: new Date(),
    };
    this.rows.set(input.id, updated);
    return updated;
  }

  async unpair(id: SlackBotConfigId) {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`config ${id} not found`);
    const updated: SlackBotConfig = {
      ...existing,
      agentId: null,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: SlackBotConfigId) {
    this.rows.delete(id);
  }
}

export class InMemorySlackInstallStore implements SlackInstallStore {
  readonly rows = new Map<string, SlackInstall>();

  async findById(id: SlackInstallId) {
    return this.rows.get(id) ?? null;
  }

  async findByBotConfigAndTeam(botConfigId: SlackBotConfigId, teamId: SlackTeamId) {
    for (const r of this.rows.values()) {
      if (
        r.botConfigId === botConfigId &&
        r.slackTeamId === teamId &&
        !r.revokedAt
      )
        return r;
    }
    return null;
  }

  async listByBotConfig(botConfigId: SlackBotConfigId) {
    return [...this.rows.values()].filter(
      (r) => r.botConfigId === botConfigId && !r.revokedAt,
    );
  }

  async findByAppAndTeam(slackAppId: string, teamId: SlackTeamId) {
    // The fake doesn't track the app id; tests that need this can
    // override. The contract tests assert behaviour via the postgres
    // adapter where the app id is materialized via a join.
    void slackAppId;
    void teamId;
    return null;
  }

  async upsert(input: {
    botConfigId: SlackBotConfigId;
    slackTeamId: SlackTeamId;
    slackTeamName: string | null;
    botToken: string;
    installedByUserId: UserId | null;
  }) {
    const existing = await this.findByBotConfigAndTeam(
      input.botConfigId,
      input.slackTeamId,
    );
    const id = existing?.id ?? SlackInstallId(randomUUID());
    const row: SlackInstall = {
      id,
      botConfigId: input.botConfigId,
      slackTeamId: input.slackTeamId,
      slackTeamName: input.slackTeamName,
      botToken: input.botToken,
      installedByUserId: input.installedByUserId,
      installedAt: existing?.installedAt ?? new Date(),
      revokedAt: null,
    };
    this.rows.set(id, row);
    return row;
  }

  async markRevoked(id: SlackInstallId, at: Date) {
    const existing = this.rows.get(id);
    if (!existing) return;
    this.rows.set(id, { ...existing, revokedAt: at });
  }
}

export class InMemorySlackInstallStateStore implements SlackInstallStateStore {
  readonly rows = new Map<
    string,
    {
      botConfigId: SlackBotConfigId;
      initiatingUserId: UserId;
      expiresAt: Date;
      returnTo: string | null;
    }
  >();

  /**
   * Clock used to evaluate expiry on `consume`. Defaults to real wall
   * time; tests that mint state rows with a fake clock should pass the
   * same clock here so expired-vs-fresh decisions stay consistent.
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async put(input: {
    state: string;
    botConfigId: SlackBotConfigId;
    initiatingUserId: UserId;
    expiresAt: Date;
    returnTo?: string | null;
  }) {
    this.rows.set(input.state, {
      botConfigId: input.botConfigId,
      initiatingUserId: input.initiatingUserId,
      expiresAt: input.expiresAt,
      returnTo: input.returnTo ?? null,
    });
  }

  async peek(state: string) {
    const row = this.rows.get(state);
    if (!row) return null;
    if (row.expiresAt.getTime() < this.now().getTime()) return null;
    return {
      botConfigId: row.botConfigId,
      initiatingUserId: row.initiatingUserId,
      returnTo: row.returnTo,
    };
  }

  async consume(state: string) {
    const row = this.rows.get(state);
    if (!row) return null;
    this.rows.delete(state);
    if (row.expiresAt.getTime() < this.now().getTime()) return null;
    return {
      botConfigId: row.botConfigId,
      initiatingUserId: row.initiatingUserId,
      returnTo: row.returnTo,
    };
  }
}

/** Programmable Slack OAuth client. Tests configure the next response. */
export class FakeSlackOAuthClient implements SlackOAuthClient {
  private next: SlackOAuthExchangeResult | Error | null = null;
  readonly calls: Array<{ code: string; redirectUri: string }> = [];

  setNextResult(result: SlackOAuthExchangeResult | Error) {
    this.next = result;
  }

  async exchangeCodeForToken(input: { code: string; redirectUri: string }) {
    this.calls.push(input);
    if (this.next instanceof Error) throw this.next;
    if (!this.next) throw new Error("FakeSlackOAuthClient not primed");
    const result = this.next;
    this.next = null;
    return result;
  }
}

export class FakeSlackManifestBuilder implements SlackManifestBuilder {
  buildManifestUrl(input: { botName: SlackBotName; state: string }) {
    return `https://api.slack.com/apps?new_app=1&bot=${encodeURIComponent(input.botName)}&state=${encodeURIComponent(input.state)}`;
  }
}

/**
 * Programmable AgentWorkspaceReader. Tests register `(agentId →
 * workspaceId)` pairs explicitly, so a test that pairs a bot with
 * an agent in workspace A vs B is unambiguous about which case it
 * covers.
 */
export class FakeAgentWorkspaceReader implements AgentWorkspaceReader {
  readonly map = new Map<string, WorkspaceId>();

  setAgentWorkspace(agentId: AgentId, workspaceId: WorkspaceId) {
    this.map.set(agentId as string, workspaceId);
  }

  async findWorkspaceId(agentId: AgentId) {
    return this.map.get(agentId as string) ?? null;
  }
}

/**
 * In-memory SlackInstallCompleter. Real implementation wraps both
 * writes in a SQL transaction; the fake just calls the underlying
 * stores inline (no atomicity guarantee in the fake — tests that need
 * to assert mid-flight failures can wrap the install store with a
 * throwing decorator).
 */
export class InMemorySlackInstallCompleter implements SlackInstallCompleter {
  constructor(
    private readonly configs: InMemorySlackBotConfigStore,
    private readonly installs: InMemorySlackInstallStore,
  ) {}

  async completeInstall(input: {
    botConfigId: SlackBotConfigId;
    slackAppId: string;
    slackBotUserId: string;
    slackTeamId: SlackTeamId;
    slackTeamName: string | null;
    botToken: string;
    installedByUserId: UserId | null;
  }) {
    const existing = await this.configs.findById(input.botConfigId);
    if (existing && !existing.slackAppId) {
      await this.configs.recordSlackAppDetails({
        id: input.botConfigId,
        slackAppId: input.slackAppId,
        slackBotUserId: input.slackBotUserId,
      });
    }
    return this.installs.upsert({
      botConfigId: input.botConfigId,
      slackTeamId: input.slackTeamId,
      slackTeamName: input.slackTeamName,
      botToken: input.botToken,
      installedByUserId: input.installedByUserId,
    });
  }
}
