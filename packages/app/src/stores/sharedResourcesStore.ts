import { create } from "zustand";
import { apiFetch } from "../lib/api";

export interface CatalogEntry {
  kind: string;
  display_name: string;
  description: string;
  versions: string[];
  default_version: string;
  default_storage_size: string;
  available: boolean;
}

export interface InstalledResource {
  id: string;
  workspace_id: string;
  kind: string;
  version: string;
  provider: string;
  config: Record<string, unknown>;
  status: "provisioning" | "running" | "failed";
  status_reason: string | null;
  installed_by: string | null;
  created_at: string;
}

interface SharedResourcesState {
  catalogBySlug: Record<string, CatalogEntry[]>;
  installedBySlug: Record<string, InstalledResource[]>;
  loadingSlug: string | null;
  errorBySlug: Record<string, string | null>;

  load(slug: string): Promise<void>;
  install(
    slug: string,
    input: { kind: string; version: string; storage_size: string },
  ): Promise<InstalledResource>;
  uninstall(slug: string, id: string): Promise<void>;
}

// Unwrap the JSON body on error so the UI shows the DomainError message
// rather than the raw "API 409: {...}" envelope.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await apiFetch<T>(path, init);
  } catch (err) {
    const msg = (err as Error).message;
    const m = /^API \d+: (.+)$/.exec(msg);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]!) as {
          message?: string;
          error?: string;
        };
        throw new Error(parsed.message ?? parsed.error ?? msg);
      } catch {
        // body wasn't JSON; fall through
      }
    }
    throw err;
  }
}

export const useSharedResourcesStore = create<SharedResourcesState>(
  (set, get) => ({
    catalogBySlug: {},
    installedBySlug: {},
    loadingSlug: null,
    errorBySlug: {},

    async load(slug) {
      set({ loadingSlug: slug });
      try {
        const base = `/api/workspaces/${slug}/shared-agent-resources`;
        const [catalog, installed] = await Promise.all([
          call<{ entries: CatalogEntry[] }>(`${base}/catalog`),
          call<{ resources: InstalledResource[] }>(base),
        ]);
        set((s) => ({
          catalogBySlug: { ...s.catalogBySlug, [slug]: catalog.entries },
          installedBySlug: {
            ...s.installedBySlug,
            [slug]: installed.resources,
          },
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

    async install(slug, input) {
      const base = `/api/workspaces/${slug}/shared-agent-resources`;
      const res = await call<{ resource: InstalledResource }>(base, {
        method: "POST",
        body: JSON.stringify({
          kind: input.kind,
          version: input.version,
          config: { storage_size: input.storage_size },
        }),
      });
      set((s) => ({
        installedBySlug: {
          ...s.installedBySlug,
          [slug]: [...(s.installedBySlug[slug] ?? []), res.resource],
        },
      }));
      return res.resource;
    },

    async uninstall(slug, id) {
      const base = `/api/workspaces/${slug}/shared-agent-resources/${id}`;
      await call(base, { method: "DELETE" });
      const current = get().installedBySlug[slug] ?? [];
      set((s) => ({
        installedBySlug: {
          ...s.installedBySlug,
          [slug]: current.filter((r) => r.id !== id),
        },
      }));
    },
  }),
);
