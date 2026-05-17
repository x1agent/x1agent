import { useEffect, useState } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import {
  usePlatformSecretsStore,
  type LlmProvider,
  type ProviderStatus,
} from "../../stores/platformSecretsStore";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { AnthropicModelsPanel, type ModelRow } from "./AnthropicModelsPanel";
import { SummarizerModelPicker } from "./SummarizerModelPicker";

/**
 * Model Settings page (renamed from "Admin Settings" — X1A-145).
 *
 * Single tabbed surface for every LLM provider the platform integrates
 * with. The Anthropic tab folds in what used to be /admin/anthropic-
 * models so the API key, the model curation list, and the summarizer
 * picker all live in one place. Adding a new provider tab is: extend
 * the tab list, drop a provider-shaped panel.
 *
 * Server-side requirePlatformAdmin middleware on /api/admin/* is the
 * real gate. The render-time check here mirrors that so a non-admin
 * URL-poker sees an explicit refusal, not a half-rendered shell.
 */
export function AdminSettingsRoot() {
  const { status, fetchMe, isPlatformAdmin } = useAuthStore();
  const { providers, loadStatus, loadError, banner, load, dismissBanner } =
    usePlatformSecretsStore();
  const [enabledModels, setEnabledModels] = useState<ModelRow[]>([]);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === "authenticated" && isPlatformAdmin && loadStatus === "idle") {
      load();
    }
  }, [status, isPlatformAdmin, loadStatus, load]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => dismissBanner(), 6000);
    return () => clearTimeout(t);
  }, [banner, dismissBanner]);

  // Honor ?tab= so a future deep-link (e.g. the old anthropic-models
  // route redirecting here) can target the right tab. Falls back to
  // "anthropic" — the most-used surface.
  const initialTab =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("tab") || "anthropic"
      : "anthropic";

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  if (status === "authenticated" && !isPlatformAdmin) {
    return (
      <AppShell breadcrumbs={[{ label: "Model Settings" }]}>
        <ForbiddenCard />
      </AppShell>
    );
  }

  const anthropic = providers.find((p) => p.provider === "anthropic");
  const openai = providers.find((p) => p.provider === "openai");
  const enabledRows = enabledModels.filter((m) => m.enabled);

  return (
    <AppShell breadcrumbs={[{ label: "Model Settings" }]}>
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Model Settings
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            Platform-wide LLM provider configuration. Workspace-scoped
            settings live under Workspace settings.
          </p>
        </header>

        {loadError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-300">
            {loadError}
          </div>
        )}

        <Tabs defaultValue={initialTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="anthropic">Anthropic</TabsTrigger>
            <TabsTrigger value="openai">OpenAI</TabsTrigger>
          </TabsList>

          <TabsContent value="anthropic" className="space-y-4">
            {anthropic && <ProviderCard provider={anthropic} />}
            <AnthropicModelsPanel onModels={setEnabledModels} />
            <SummarizerModelPicker enabledModels={enabledRows} />
          </TabsContent>

          <TabsContent value="openai" className="space-y-4">
            {openai && <ProviderCard provider={openai} />}
          </TabsContent>
        </Tabs>

        {banner && <RestartBannerView />}
      </div>
    </AppShell>
  );
}

/* ---------- API key card ---------------------------------------------- */

interface ProviderCardProps {
  provider: ProviderStatus;
}

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

function ProviderGlyph({ provider }: { provider: LlmProvider }) {
  const isAnthropic = provider === "anthropic";
  return (
    <span
      aria-hidden
      className={`inline-grid h-6 w-6 place-items-center rounded-md text-[11px] font-bold ${
        isAnthropic ? "bg-accent text-accent-fg" : "bg-[#10a37f] text-white"
      }`}
    >
      {isAnthropic ? "A" : "O"}
    </span>
  );
}

const KEY_HELP_URL: Record<LlmProvider, string> = {
  anthropic: "https://console.anthropic.com",
  openai: "https://platform.openai.com/api-keys",
};

const KEY_PLACEHOLDER: Record<LlmProvider, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
};

function ProviderCard({ provider }: ProviderCardProps) {
  const { saveKey, clearKey, saving } = usePlatformSecretsStore();
  const isSaving = !!saving[provider.provider];
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const onSave = async () => {
    if (draft.trim().length === 0) return;
    const ok = await saveKey(provider.provider, draft.trim());
    if (ok) {
      setDraft("");
      setEditing(false);
    }
  };

  const onClear = async () => {
    const ok = await clearKey(provider.provider);
    if (ok) setConfirmingClear(false);
  };

  return (
    <article
      data-testid={`provider-card-${provider.provider}`}
      className="rounded-lg border border-border-soft bg-surface-elevated p-4"
    >
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-fg">
          <ProviderGlyph provider={provider.provider} />
          {PROVIDER_LABEL[provider.provider]} API key
        </div>
        <StatusBadge configured={provider.configured} />
      </header>

      {!provider.configured && (
        <>
          <div className="flex gap-2">
            <input
              data-testid={`key-input-${provider.provider}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={KEY_PLACEHOLDER[provider.provider]}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border-soft bg-canvas px-3 py-1.5 font-mono text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
            <button
              type="button"
              data-testid={`key-save-${provider.provider}`}
              onClick={onSave}
              disabled={isSaving || draft.trim().length === 0}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg transition disabled:opacity-50"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-fg-faint">
            Get a key at{" "}
            <a
              href={KEY_HELP_URL[provider.provider]}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {KEY_HELP_URL[provider.provider].replace(/^https?:\/\//, "")}
            </a>
          </p>
        </>
      )}

      {provider.configured && !editing && (
        <>
          <div className="flex gap-2">
            <input
              type="password"
              value="••••••••••••••••••••••••"
              readOnly
              className="min-w-0 flex-1 rounded-md border border-border-soft bg-canvas px-3 py-1.5 font-mono text-sm text-fg-muted"
            />
            <button
              type="button"
              data-testid={`key-update-${provider.provider}`}
              onClick={() => setEditing(true)}
              className="rounded-md border border-border-soft bg-transparent px-3 py-1.5 text-xs text-fg-muted hover:bg-surface"
            >
              Update
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <p className="text-[11px] text-fg-faint">
              Get a key at{" "}
              <a
                href={KEY_HELP_URL[provider.provider]}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                {KEY_HELP_URL[provider.provider].replace(/^https?:\/\//, "")}
              </a>
            </p>
            {confirmingClear ? (
              <span
                role="group"
                aria-label="Clear key confirm"
                className="flex items-center gap-2 text-xs text-fg-muted"
              >
                Clear key?
                <button
                  type="button"
                  onClick={() => setConfirmingClear(false)}
                  className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-xs text-fg-muted hover:bg-surface"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid={`key-clear-confirm-${provider.provider}`}
                  onClick={onClear}
                  disabled={isSaving}
                  className="rounded-md border border-red-400/40 bg-transparent px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {isSaving ? "Clearing…" : "Yes, clear"}
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-testid={`key-clear-${provider.provider}`}
                onClick={() => setConfirmingClear(true)}
                className="rounded-md border border-red-400/40 bg-transparent px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
              >
                Clear
              </button>
            )}
          </div>
        </>
      )}

      {provider.configured && editing && (
        <>
          <div className="flex gap-2">
            <input
              data-testid={`key-input-${provider.provider}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder={`New ${KEY_PLACEHOLDER[provider.provider]}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border-soft bg-canvas px-3 py-1.5 font-mono text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
            <button
              type="button"
              data-testid={`key-save-${provider.provider}`}
              onClick={onSave}
              disabled={isSaving || draft.trim().length === 0}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg transition disabled:opacity-50"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
              className="rounded-md border border-border-soft bg-transparent px-3 py-1.5 text-xs text-fg-muted hover:bg-surface"
            >
              Cancel
            </button>
          </div>
          <p className="mt-2 text-[11px] text-fg-faint">
            Replaces the current key; the API will restart so the new value
            takes effect.
          </p>
        </>
      )}
    </article>
  );
}

function StatusBadge({ configured }: { configured: boolean }) {
  if (configured) {
    return (
      <span
        data-testid="status-configured"
        className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300"
      >
        Configured
      </span>
    );
  }
  return (
    <span
      data-testid="status-not-configured"
      className="rounded-full border border-border-soft bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-faint"
    >
      Not configured
    </span>
  );
}

function RestartBannerView() {
  return (
    <div
      role="status"
      data-testid="restart-banner"
      className="flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-2.5 text-xs text-amber-200"
    >
      <span className="h-2 w-2 rounded-full bg-amber-400" />
      Saved. API will restart in ~30s. Active sessions will reconnect
      automatically.
    </div>
  );
}

function ForbiddenCard() {
  return (
    <div className="mx-auto mt-20 max-w-md rounded-lg border border-red-400/30 bg-surface p-6 text-center">
      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-md bg-red-500/10 text-lg text-red-300">
        !
      </div>
      <h2 className="mb-1 text-base font-semibold text-fg">Forbidden</h2>
      <p className="text-xs text-fg-muted">
        You don&apos;t have permission to access platform admin settings.
      </p>
      <a
        href="/"
        className="mt-4 inline-block rounded-md border border-border-soft bg-transparent px-4 py-1.5 text-xs text-fg-muted hover:bg-surface"
      >
        Back to dashboard
      </a>
    </div>
  );
}
