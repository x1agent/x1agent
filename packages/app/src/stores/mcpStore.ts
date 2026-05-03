import { create } from "zustand";
import { apiFetch } from "../lib/api";

/**
 * MCP catalog entries (workspace-scoped) + per-agent attachments +
 * per-user OAuth tokens. Mirrors the shape of useCollectionsStore:
 * normalized caches keyed on workspace slug / agent key, async
 * actions that hit apiFetch and write back. Components consume via
 * selectors and call store actions — never apiFetch directly.
 */

export type CatalogKind = "stdio" | "remote_oauth";

export interface CatalogEntry {
  id: string;
  name: string;
  display_name: string | null;
  kind: CatalogKind;
  image: string | null;
  command: string | null;
  args: string[];
  url: string | null;
  manifest: {
    env: Record<
      string,
      { kind: "secret" | "value"; label?: string; required?: boolean; description?: string }
    >;
    tool_scopes: Record<string, string[]>;
  };
  description: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export type AttachmentEnvValue =
  | { kind: "secret"; ref: string }
  | { kind: "value"; value: string };

export interface Attachment {
  id: string;
  agent_id: string;
  catalog_entry_id: string;
  env_json: Record<string, AttachmentEnvValue>;
  tool_scopes_granted: string[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface UserMcpToken {
  catalog_entry_id: string;
  access_token_expires_at: string | null;
  scope: string | null;
  has_refresh_token: boolean;
  created_at: string;
  updated_at: string;
}

interface RegisterCatalogInput {
  name: string;
  display_name?: string | null;
  kind: CatalogKind;
  image?: string | null;
  command?: string | null;
  args?: string[];
  url?: string | null;
  manifest: unknown;
  description?: string;
}

interface AttachInput {
  catalog_entry_id: string;
  env_json: Record<string, AttachmentEnvValue>;
}

interface McpState {
  // ── normalized caches ─────────────────────────────────────────
  catalogBySlug: Record<string, CatalogEntry[]>;
  attachmentsByAgentKey: Record<string, Attachment[]>;
  /** Per-user — single key for the active session. */
  userTokens: UserMcpToken[];

  loadingCatalogSlug: string | null;
  loadingAttachmentsKey: string | null;
  loadingTokens: boolean;

  errorCatalogBySlug: Record<string, string | null>;
  errorAttachmentsByKey: Record<string, string | null>;
  errorTokens: string | null;

  // ── actions ───────────────────────────────────────────────────
  loadCatalog(slug: string): Promise<void>;
  registerCatalogEntry(slug: string, input: RegisterCatalogInput): Promise<CatalogEntry>;
  deleteCatalogEntry(slug: string, entryId: string): Promise<void>;

  loadAttachments(slug: string, agentId: string): Promise<void>;
  attach(slug: string, agentId: string, input: AttachInput): Promise<Attachment>;
  detach(slug: string, agentId: string, attachmentId: string): Promise<void>;

  loadUserTokens(): Promise<void>;
  disconnectToken(catalogEntryId: string): Promise<void>;
}

const agentKey = (slug: string, agentId: string) => `${slug}:${agentId}`;

export const useMcpStore = create<McpState>((set, get) => ({
  catalogBySlug: {},
  attachmentsByAgentKey: {},
  userTokens: [],

  loadingCatalogSlug: null,
  loadingAttachmentsKey: null,
  loadingTokens: false,

  errorCatalogBySlug: {},
  errorAttachmentsByKey: {},
  errorTokens: null,

  async loadCatalog(slug) {
    set({ loadingCatalogSlug: slug });
    try {
      const r = await apiFetch<{ entries: CatalogEntry[] }>(
        `/api/workspaces/${slug}/mcp-catalog`,
      );
      set((s) => ({
        catalogBySlug: { ...s.catalogBySlug, [slug]: r.entries },
        errorCatalogBySlug: { ...s.errorCatalogBySlug, [slug]: null },
      }));
    } catch (err) {
      const msg = (err as Error).message;
      set((s) => ({
        errorCatalogBySlug: { ...s.errorCatalogBySlug, [slug]: msg },
      }));
      throw err;
    } finally {
      if (get().loadingCatalogSlug === slug) {
        set({ loadingCatalogSlug: null });
      }
    }
  },

  async registerCatalogEntry(slug, input) {
    const entry = await apiFetch<CatalogEntry>(
      `/api/workspaces/${slug}/mcp-catalog`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    // Refresh on success — server may normalize the input (e.g.
    // discovery + DCR populate url + oauth metadata for remote_oauth).
    await get().loadCatalog(slug);
    return entry;
  },

  async deleteCatalogEntry(slug, entryId) {
    await apiFetch(`/api/workspaces/${slug}/mcp-catalog/${entryId}`, {
      method: "DELETE",
    });
    set((s) => ({
      catalogBySlug: {
        ...s.catalogBySlug,
        [slug]: (s.catalogBySlug[slug] ?? []).filter((e) => e.id !== entryId),
      },
    }));
  },

  async loadAttachments(slug, agentId) {
    const key = agentKey(slug, agentId);
    set({ loadingAttachmentsKey: key });
    try {
      const r = await apiFetch<{ attachments: Attachment[] }>(
        `/api/workspaces/${slug}/agents/${agentId}/mcp-attachments`,
      );
      set((s) => ({
        attachmentsByAgentKey: { ...s.attachmentsByAgentKey, [key]: r.attachments },
        errorAttachmentsByKey: { ...s.errorAttachmentsByKey, [key]: null },
      }));
    } catch (err) {
      const msg = (err as Error).message;
      set((s) => ({
        errorAttachmentsByKey: { ...s.errorAttachmentsByKey, [key]: msg },
      }));
      throw err;
    } finally {
      if (get().loadingAttachmentsKey === key) {
        set({ loadingAttachmentsKey: null });
      }
    }
  },

  async attach(slug, agentId, input) {
    const att = await apiFetch<Attachment>(
      `/api/workspaces/${slug}/agents/${agentId}/mcp-attachments`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    // Refresh from server so any constraint (kind / agent compat)
    // surfaces as the persisted truth, not optimistic state.
    await get().loadAttachments(slug, agentId);
    return att;
  },

  async detach(slug, agentId, attachmentId) {
    await apiFetch(
      `/api/workspaces/${slug}/agents/${agentId}/mcp-attachments/${attachmentId}`,
      { method: "DELETE" },
    );
    const key = agentKey(slug, agentId);
    set((s) => ({
      attachmentsByAgentKey: {
        ...s.attachmentsByAgentKey,
        [key]: (s.attachmentsByAgentKey[key] ?? []).filter(
          (a) => a.id !== attachmentId,
        ),
      },
    }));
  },

  async loadUserTokens() {
    set({ loadingTokens: true });
    try {
      const r = await apiFetch<{ tokens: UserMcpToken[] }>(
        `/api/users/me/mcp-tokens`,
      );
      set({ userTokens: r.tokens, errorTokens: null });
    } catch (err) {
      // Pre-deploy or unauth — degrade to empty rather than blow up.
      set({ userTokens: [], errorTokens: (err as Error).message });
    } finally {
      set({ loadingTokens: false });
    }
  },

  async disconnectToken(catalogEntryId) {
    await apiFetch(`/api/users/me/mcp-tokens/${catalogEntryId}`, {
      method: "DELETE",
    });
    set((s) => ({
      userTokens: s.userTokens.filter((t) => t.catalog_entry_id !== catalogEntryId),
    }));
  },
}));

export const mcpAgentKey = agentKey;
