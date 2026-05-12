import { create } from "zustand";
import { apiFetch, API_BASE } from "../lib/api";

export interface GitIdentity {
  name: string;
  email: string;
}

interface GitIdentityState {
  /** Null when the user has no identity set; undefined while loading. */
  identity: GitIdentity | null | undefined;
  status: "idle" | "loading" | "ready" | "error";
  /** "validation_error" / generic API error / null. */
  error: string | null;
  /** When the api returns a field-level validation error, surface it here. */
  fieldError: { field: string; message: string } | null;
  /** True while a save round-trip is in flight (PUT / DELETE). */
  saving: boolean;

  load(): Promise<void>;
  save(input: { name: string; email: string }): Promise<boolean>;
  clear(): Promise<void>;
}

export const useGitIdentityStore = create<GitIdentityState>((set) => ({
  identity: undefined,
  status: "idle",
  error: null,
  fieldError: null,
  saving: false,

  async load() {
    set({ status: "loading", error: null, fieldError: null });
    try {
      const res = await apiFetch<{ git_identity: GitIdentity | null }>(
        "/api/me/git-identity",
      );
      set({ identity: res.git_identity, status: "ready" });
    } catch (err) {
      set({ status: "error", error: (err as Error).message });
    }
  },

  async save(input) {
    set({ saving: true, error: null, fieldError: null });
    // Hand-roll the fetch — we want to surface the field-level error
    // shape returned by the API on 400, which apiFetch's "throw on
    // !ok" wrapper would collapse into a generic message.
    try {
      const res = await fetch(`${API_BASE}/api/me/git-identity`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 400 && body && typeof body.field === "string") {
          set({
            saving: false,
            fieldError: {
              field: body.field,
              message: typeof body.message === "string" ? body.message : "Invalid value",
            },
          });
        } else {
          set({
            saving: false,
            error:
              typeof body.message === "string"
                ? body.message
                : `API ${res.status}`,
          });
        }
        return false;
      }
      set({
        saving: false,
        identity: body.git_identity ?? null,
        status: "ready",
        error: null,
        fieldError: null,
      });
      return true;
    } catch (err) {
      set({ saving: false, error: (err as Error).message });
      return false;
    }
  },

  async clear() {
    set({ saving: true, error: null, fieldError: null });
    try {
      // 204 No Content — bypass apiFetch (which assumes a JSON body).
      const res = await fetch(`${API_BASE}/api/me/git-identity`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      set({ saving: false, identity: null });
    } catch (err) {
      set({ saving: false, error: (err as Error).message });
    }
  },
}));
