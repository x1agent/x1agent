import { create } from "zustand";
import { apiFetch } from "../lib/api";

/**
 * Zustand store for the Admin Settings → LLM Provider Keys section
 * (X1A-46). Owns the "configured/not-configured" status table for
 * every provider and the async actions to set / clear keys.
 *
 * The store NEVER holds a key value. The frontend only ever sees
 * booleans — the actual value lives in the api pod's process.env and
 * the platform-secrets K8s Secret. This mirrors the server contract
 * (status.ts) so a reflection bug on either side is contained.
 */

export type LlmProvider = "anthropic" | "openai";

export interface ProviderStatus {
  provider: LlmProvider;
  configured: boolean;
}

interface StatusResponse {
  providers: ProviderStatus[];
}

interface SaveResponse {
  provider: LlmProvider;
  configured: boolean;
  restart: "pending" | "none";
}

/**
 * Per-provider banner state surfaced after a Save / Clear succeeds.
 * The UI renders these as the "API will restart in ~30s" toast that
 * the CEO greenlit in the mockup-v1 comment.
 */
export interface RestartBanner {
  kind: "saved" | "cleared";
  provider: LlmProvider;
  /** Set by the store; the component renders a fresh banner per save. */
  at: number;
}

interface PlatformSecretsState {
  providers: ProviderStatus[];
  loadStatus: "idle" | "loading" | "ready" | "error";
  loadError: string | null;
  saving: Partial<Record<LlmProvider, boolean>>;
  banner: RestartBanner | null;

  load(): Promise<void>;
  saveKey(provider: LlmProvider, value: string): Promise<boolean>;
  clearKey(provider: LlmProvider): Promise<boolean>;
  dismissBanner(): void;
}

const EMPTY_PROVIDERS: ProviderStatus[] = [
  { provider: "anthropic", configured: false },
  { provider: "openai", configured: false },
];

export const usePlatformSecretsStore = create<PlatformSecretsState>(
  (set, get) => ({
    providers: EMPTY_PROVIDERS,
    loadStatus: "idle",
    loadError: null,
    saving: {},
    banner: null,

    async load() {
      set({ loadStatus: "loading", loadError: null });
      try {
        const res = await apiFetch<StatusResponse>(
          "/api/admin/platform-secrets/llm",
        );
        set({ providers: res.providers, loadStatus: "ready" });
      } catch (err) {
        set({ loadStatus: "error", loadError: (err as Error).message });
      }
    },

    async saveKey(provider, value) {
      set({
        saving: { ...get().saving, [provider]: true },
      });
      try {
        const res = await apiFetch<SaveResponse>(
          `/api/admin/platform-secrets/llm/${provider}`,
          {
            method: "PUT",
            body: JSON.stringify({ value }),
          },
        );
        const next = get().providers.map((p) =>
          p.provider === provider ? { ...p, configured: res.configured } : p,
        );
        set({
          providers: next,
          saving: { ...get().saving, [provider]: false },
          banner: { kind: "saved", provider, at: Date.now() },
        });
        return true;
      } catch (err) {
        set({
          saving: { ...get().saving, [provider]: false },
          loadError: (err as Error).message,
        });
        return false;
      }
    },

    async clearKey(provider) {
      set({ saving: { ...get().saving, [provider]: true } });
      try {
        await apiFetch<SaveResponse>(
          `/api/admin/platform-secrets/llm/${provider}`,
          { method: "DELETE" },
        );
        const next = get().providers.map((p) =>
          p.provider === provider ? { ...p, configured: false } : p,
        );
        set({
          providers: next,
          saving: { ...get().saving, [provider]: false },
          banner: { kind: "cleared", provider, at: Date.now() },
        });
        return true;
      } catch (err) {
        set({
          saving: { ...get().saving, [provider]: false },
          loadError: (err as Error).message,
        });
        return false;
      }
    },

    dismissBanner() {
      set({ banner: null });
    },
  }),
);
