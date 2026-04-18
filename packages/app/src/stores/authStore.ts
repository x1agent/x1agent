import { create } from "zustand";
import type { User, WorkspaceMembership } from "@x1agent/shared";
import { apiFetch, API_BASE } from "../lib/api";

interface AuthState {
  user: User | null;
  memberships: WorkspaceMembership[];
  isPlatformAdmin: boolean;
  status: "idle" | "loading" | "authenticated" | "anonymous";
  error: string | null;
  fetchMe: () => Promise<void>;
  signIn: () => void;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  memberships: [],
  isPlatformAdmin: false,
  status: "idle",
  error: null,

  fetchMe: async () => {
    set({ status: "loading", error: null });
    try {
      const me = await apiFetch<{
        user: User;
        memberships: WorkspaceMembership[];
        is_platform_admin: boolean;
      }>("/auth/me");
      set({
        user: me.user,
        memberships: me.memberships,
        isPlatformAdmin: me.is_platform_admin,
        status: "authenticated",
      });
    } catch (err) {
      set({
        user: null,
        memberships: [],
        isPlatformAdmin: false,
        status: "anonymous",
        error: (err as Error).message,
      });
    }
  },

  signIn: () => {
    window.location.href = `${API_BASE}/auth/google`;
  },

  signOut: async () => {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    set({
      user: null,
      memberships: [],
      isPlatformAdmin: false,
      status: "anonymous",
    });
    window.location.href = "/";
  },
}));
