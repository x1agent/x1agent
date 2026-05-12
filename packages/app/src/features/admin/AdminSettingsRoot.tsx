import { useEffect, useState } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import {
  usePlatformSecretsStore,
  type LlmProvider,
  type ProviderStatus,
} from "../../stores/platformSecretsStore";

/**
 * X1A-46 — Admin Settings page.
 *
 * Layout pinned to the CEO-greenlit mockup-v1 (Linear ticket comment
 * 2026-05-12):
 *   - Title + subtitle
 *   - Section "LLM Provider Keys" with side-by-side Anthropic / OpenAI
 *     cards. Letter-square glyphs (A on terracotta, O on green). Status
 *     badge. Masked input + Save (or Update + Clear) controls. Inline
 *     replacement on Update; inline confirm on Clear (no modal).
 *   - Future-sections stub at the bottom: "Telemetry · Workspace
 *     Defaults · Feature Flags" — faded, non-interactive.
 *   - Non-admin who URL-pokes here gets the 403 affordance below; the
 *     real gate lives on /api/admin/* via requirePlatformAdmin.
 *
 * Status booleans are the ONLY thing the api ever returns about
 * platform keys — never the value, never a prefix. Update / Save flow
 * goes through usePlatformSecretsStore, which calls the gated PUT
 * route and surfaces the "API will restart in ~30s" banner after a
 * successful write.
 */
export function AdminSettingsRoot() {
  const { status, fetchMe, isPlatformAdmin } = useAuthStore();
  const {
    providers,
    loadStatus,
    loadError,
    saving,
    banner,
    load,
    dismissBanner,
  } = usePlatformSecretsStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === "authenticated" && isPlatformAdmin && loadStatus === "idle") {
      load();
    }
  }, [status, isPlatformAdmin, loadStatus, load]);

  // Auto-dismiss the restart banner after a beat — matches the mockup
  // "subtle flash" intent. Long enough to read, short enough to stop
  // covering the page once the message lands. The store action that
  // mints a banner sets `at`, so a fresh save resets the timer.
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => dismissBanner(), 6000);
    return () => clearTimeout(t);
  }, [banner, dismissBanner]);

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  // Server-side 403 is what really protects this surface (route uses
  // requirePlatformAdmin). This branch renders the same "forbidden"
  // card from the mockup so a non-admin URL-poker sees the explicit
  // refusal page, not a half-rendered shell.
  if (status === "authenticated" && !isPlatformAdmin) {
    return (
      <AppShell breadcrumbs={[{ label: "Admin Settings" }]}>
        <ForbiddenCard />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Admin Settings" }]}>
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            Admin Settings
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            Platform-wide configuration. Workspace-scoped settings are under
            Workspace settings.
          </p>
        </header>

        <section
          aria-labelledby="llm-keys-heading"
          className="overflow-hidden rounded-lg border border-border-soft bg-surface"
        >
          <div className="flex items-center justify-between border-b border-border-soft px-5 py-4">
            <h2
              id="llm-keys-heading"
              className="text-sm font-semibold text-fg"
            >
              LLM Provider Keys
            </h2>
            <span className="text-xs text-fg-muted">
              Used by every agent in every workspace · stored as platform
              secrets
            </span>
          </div>

          {loadError && (
            <div className="px-5 py-3 text-sm text-red-400">{loadError}</div>
          )}

          <div className="grid gap-4 p-5 md:grid-cols-2">
            {providers.map((p) => (
              <ProviderCard
                key={p.provider}
                provider={p}
                saving={!!saving[p.provider]}
              />
            ))}
          </div>

          {banner && <RestartBannerView />}

          <div className="flex items-center gap-3 border-t border-dashed border-border-soft px-5 py-3 text-xs text-fg-faint">
            <span className="rounded bg-surface-elevated px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
              Phase 2
            </span>
            Other providers (Gemini, Bedrock, Cohere) extend the same card
            pattern — out of scope for v1.
          </div>
        </section>

        <FutureSectionsStub />
      </div>
    </AppShell>
  );
}

/* ---------- pieces ----------------------------------------------------- */

interface ProviderCardProps {
  provider: ProviderStatus;
  saving: boolean;
}

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/**
 * Single-letter glyph on brand-color square. CEO greenlit letter
 * squares over proper SVG logos: ship faster, side-step trademark
 * drift. Anthropic = terracotta (matches --color-accent), OpenAI =
 * green (signature OpenAI brand). Promote to real logos as a phase-2
 * polish if anyone cares.
 */
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

function ProviderCard({ provider, saving }: ProviderCardProps) {
  const { saveKey, clearKey } = usePlatformSecretsStore();
  const [draft, setDraft] = useState("");
  // "editing" toggles the configured card into update-mode (inline
  // replacement input). Per the mockup: NOT a modal.
  const [editing, setEditing] = useState(false);
  // "confirmingClear" toggles the configured card's footer into the
  // one-step inline confirm. Per the mockup: NOT a second modal.
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
          {PROVIDER_LABEL[provider.provider]}
        </div>
        <StatusBadge configured={provider.configured} />
      </header>

      {/* Empty state: not configured. Always shows the Save form. */}
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
              disabled={saving || draft.trim().length === 0}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg transition disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
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

      {/* Configured + not editing: read-only mask + Update / Clear. */}
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
                  disabled={saving}
                  className="rounded-md border border-red-400/40 bg-transparent px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {saving ? "Clearing…" : "Yes, clear"}
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

      {/* Configured + editing: inline replacement input (NOT a modal). */}
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
              disabled={saving || draft.trim().length === 0}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg transition disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
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
  // CEO greenlit auto-restart-on-save with this exact copy. Worded
  // active-voice + concrete duration so the admin doesn't refresh
  // tabs trying to figure out if the save took.
  return (
    <div
      role="status"
      data-testid="restart-banner"
      className="flex items-center gap-2 border-y border-amber-400/30 bg-amber-400/5 px-5 py-2.5 text-xs text-amber-200"
    >
      <span className="h-2 w-2 rounded-full bg-amber-400" />
      Saved. API will restart in ~30s. Active sessions will reconnect
      automatically.
    </div>
  );
}

function FutureSectionsStub() {
  return (
    <section
      aria-label="Future sections"
      className="rounded-lg border border-dashed border-border-soft bg-surface/40 px-5 py-6 text-center opacity-60"
    >
      <p className="text-sm text-fg-muted">
        Telemetry · Workspace Defaults · Feature Flags
      </p>
      <p className="mt-1 text-xs text-fg-faint">
        Coming in future updates. Workspace-scoped settings already live
        under Workspace settings.
      </p>
    </section>
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
