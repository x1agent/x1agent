import { create } from "zustand";
import { apiFetch, API_BASE } from "../lib/api";

export interface LinkedAccount {
  user_id: string;
  email: string;
  name: string;
  is_current: boolean;
}

interface AccountsState {
  accounts: LinkedAccount[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;

  load(): Promise<void>;
  startAddAccount(): Promise<void>;
  switchTo(userId: string): Promise<void>;
  unlink(userId: string): Promise<void>;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  status: "idle",
  error: null,

  async load() {
    set({ status: "loading", error: null });
    try {
      const res = await apiFetch<{ accounts: LinkedAccount[] }>(
        "/auth/accounts",
      );
      set({ accounts: res.accounts, status: "ready" });
    } catch (err) {
      set({ status: "error", error: (err as Error).message });
    }
  },

  async startAddAccount() {
    const res = await apiFetch<{ authorize_url: string }>(
      "/auth/link/begin",
      { method: "POST" },
    );
    window.location.href = res.authorize_url;
  },

  async switchTo(userId) {
    const res = await apiFetch<{ workspace_slug: string }>(
      "/auth/switch_account",
      { method: "POST", body: JSON.stringify({ user_id: userId }) },
    );
    window.location.href = `/workspaces/${res.workspace_slug}`;
  },

  async unlink(userId) {
    await apiFetch(`${API_BASE}/auth/unlink`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    });
    await get().load();
  },
}));
