import { create } from "zustand";
import { apiFetch } from "../lib/api";

export interface SlackInstallDTO {
  id: string;
  slack_team_id: string;
  slack_team_name: string | null;
  installed_at: string;
}

export interface SlackBotDTO {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  bot_name: string;
  slack_app_id: string | null;
  slack_bot_user_id: string | null;
  has_signing_secret: boolean;
  created_at: string;
  updated_at: string;
  installs: SlackInstallDTO[];
}

interface ListResponse {
  configured: boolean;
  bots: SlackBotDTO[];
}

interface CreateResponse {
  bot: SlackBotDTO;
  manifest_url: string;
  state: string;
}

/** keyed by workspaceSlug. */
interface SlackState {
  configuredByWorkspace: Record<string, boolean>;
  botsByWorkspace: Record<string, SlackBotDTO[]>;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;

  load(workspaceSlug: string): Promise<void>;
  createBot(
    workspaceSlug: string,
    botName: string,
    returnTo?: string,
  ): Promise<CreateResponse>;
  deleteBot(workspaceSlug: string, botId: string): Promise<void>;
  pairBot(
    workspaceSlug: string,
    botId: string,
    agentId: string,
  ): Promise<SlackBotDTO>;
  unpairBot(workspaceSlug: string, botId: string): Promise<SlackBotDTO>;
  recordSigningSecret(
    workspaceSlug: string,
    botId: string,
    plaintext: string,
  ): Promise<SlackBotDTO>;
}

export const useSlackStore = create<SlackState>((set, get) => ({
  configuredByWorkspace: {},
  botsByWorkspace: {},
  status: "idle",
  error: null,

  async load(workspaceSlug) {
    set({ status: "loading", error: null });
    try {
      const res = await apiFetch<ListResponse>(
        `/api/workspaces/${workspaceSlug}/slack/bots`,
      );
      set((s) => ({
        configuredByWorkspace: {
          ...s.configuredByWorkspace,
          [workspaceSlug]: res.configured,
        },
        botsByWorkspace: { ...s.botsByWorkspace, [workspaceSlug]: res.bots },
        status: "ready",
      }));
    } catch (err) {
      set({ status: "error", error: (err as Error).message });
    }
  },

  async createBot(workspaceSlug, botName, returnTo) {
    const res = await apiFetch<CreateResponse>(
      `/api/workspaces/${workspaceSlug}/slack/bots`,
      {
        method: "POST",
        body: JSON.stringify({ bot_name: botName, return_to: returnTo }),
      },
    );
    // Optimistically insert. The real install row attaches when the
    // OAuth callback returns; load() will refresh on landing back.
    set((s) => ({
      botsByWorkspace: {
        ...s.botsByWorkspace,
        [workspaceSlug]: [res.bot, ...(s.botsByWorkspace[workspaceSlug] ?? [])],
      },
    }));
    return res;
  },

  async deleteBot(workspaceSlug, botId) {
    await apiFetch(
      `/api/workspaces/${workspaceSlug}/slack/bots/${botId}`,
      { method: "DELETE" },
    );
    await get().load(workspaceSlug);
  },

  async pairBot(workspaceSlug, botId, agentId) {
    const res = await apiFetch<{ bot: SlackBotDTO }>(
      `/api/workspaces/${workspaceSlug}/slack/bots/${botId}/pair`,
      { method: "POST", body: JSON.stringify({ agent_id: agentId }) },
    );
    await get().load(workspaceSlug);
    return res.bot;
  },

  async unpairBot(workspaceSlug, botId) {
    const res = await apiFetch<{ bot: SlackBotDTO }>(
      `/api/workspaces/${workspaceSlug}/slack/bots/${botId}/pair`,
      { method: "DELETE" },
    );
    await get().load(workspaceSlug);
    return res.bot;
  },

  async recordSigningSecret(workspaceSlug, botId, plaintext) {
    const res = await apiFetch<{ bot: SlackBotDTO }>(
      `/api/workspaces/${workspaceSlug}/slack/bots/${botId}/signing-secret`,
      {
        method: "POST",
        body: JSON.stringify({ signing_secret: plaintext }),
      },
    );
    // Patch the row in place rather than reloading the whole list —
    // avoids a flicker on the paste-back card.
    set((s) => ({
      botsByWorkspace: {
        ...s.botsByWorkspace,
        [workspaceSlug]: (s.botsByWorkspace[workspaceSlug] ?? []).map((b) =>
          b.id === botId ? { ...b, has_signing_secret: true } : b,
        ),
      },
    }));
    return res.bot;
  },
}));
