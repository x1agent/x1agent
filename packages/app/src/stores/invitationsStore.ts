import { create } from "zustand";
import type {
  InvitationDTO,
  InvitationListResponse,
  Role,
} from "@x1agent/shared";
import { apiFetch } from "../lib/api";

interface InvitationsState {
  bySlug: Record<string, InvitationDTO[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(slug: string): Promise<void>;
  create(slug: string, email: string, role: Role): Promise<InvitationDTO>;
  revoke(slug: string, id: string): Promise<void>;
  changeRole(slug: string, id: string, role: Role): Promise<void>;
}

export const useInvitationsStore = create<InvitationsState>((set, get) => ({
  bySlug: {},
  loadingSlug: null,
  errorBySlug: {},

  async load(slug) {
    set({ loadingSlug: slug });
    try {
      const res = await apiFetch<InvitationListResponse>(
        `/api/workspaces/${slug}/invitations`,
      );
      set((s) => ({
        bySlug: { ...s.bySlug, [slug]: res.invitations },
        errorBySlug: { ...s.errorBySlug, [slug]: null },
        loadingSlug: null,
      }));
    } catch (err) {
      set((s) => ({
        errorBySlug: { ...s.errorBySlug, [slug]: (err as Error).message },
        loadingSlug: null,
      }));
    }
  },

  async create(slug, email, role) {
    const res = await apiFetch<{ invitation: InvitationDTO }>(
      `/api/workspaces/${slug}/invitations`,
      {
        method: "POST",
        body: JSON.stringify({ email, role }),
      },
    );
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [slug]: [res.invitation, ...(s.bySlug[slug] ?? [])],
      },
    }));
    return res.invitation;
  },

  async revoke(slug, id) {
    // Use the returned row so revoked invites can still surface
    // historically under a "show revoked" toggle in the UI rather
    // than vanishing — but if the API returns 204 we synthesize the
    // revoked state locally.
    const res = await apiFetch<{ invitation?: InvitationDTO } | undefined>(
      `/api/workspaces/${slug}/invitations/${id}`,
      { method: "DELETE" },
    );
    const current = get().bySlug[slug] ?? [];
    const revoked = res?.invitation;
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [slug]: current.map((i) =>
          i.id !== id
            ? i
            : revoked ?? { ...i, revoked_at: new Date().toISOString() },
        ),
      },
    }));
  },

  async changeRole(slug, id, role) {
    const res = await apiFetch<{ invitation: InvitationDTO }>(
      `/api/workspaces/${slug}/invitations/${id}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
    const current = get().bySlug[slug] ?? [];
    set((s) => ({
      bySlug: {
        ...s.bySlug,
        [slug]: current.map((i) => (i.id === id ? res.invitation : i)),
      },
    }));
  },
}));
