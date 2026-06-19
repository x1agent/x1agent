import { useEffect, useState } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import {
  usePreviewEnvironmentsStore,
  type DeployStatus,
} from "../../stores/previewEnvironmentsStore";

interface Props {
  workspaceSlug: string;
  envId: string;
}

function StatusPill({ status }: { status: DeployStatus }) {
  const styles: Record<DeployStatus, string> = {
    pending: "bg-yellow-500/15 text-yellow-300",
    provisioning: "bg-blue-500/15 text-blue-300",
    ready: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-red-500/15 text-red-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      <span className="text-sm text-fg">{children}</span>
    </div>
  );
}

export function EnvironmentDetailRoot({ workspaceSlug, envId }: Props) {
  const { memberships, status: authStatus, fetchMe } = useAuthStore();
  const env = usePreviewEnvironmentsStore((s) => s.byId[envId]);
  const loadById = usePreviewEnvironmentsStore((s) => s.loadById);
  const rename = usePreviewEnvironmentsStore((s) => s.rename);
  const remove = usePreviewEnvironmentsStore((s) => s.delete);
  const setEnvVarNames = usePreviewEnvironmentsStore((s) => s.setEnvVarNames);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authStatus === "idle") fetchMe();
  }, [authStatus, fetchMe]);
  useEffect(() => {
    if (workspaceSlug && envId) loadById(workspaceSlug, envId);
  }, [workspaceSlug, envId, loadById]);
  useEffect(() => {
    if (env && !renaming) setRenameValue(env.title);
  }, [env, renaming]);

  if (authStatus === "loading" || authStatus === "idle") {
    return (
      <AppShell>
        <div className="p-8 text-sm text-fg-muted">Loading…</div>
      </AppShell>
    );
  }
  if (authStatus === "anonymous") {
    if (typeof window !== "undefined") window.location.href = "/";
    return null;
  }

  const ws = memberships.find((m) => m.slug === workspaceSlug);
  if (!ws) {
    return (
      <AppShell>
        <div className="space-y-2 p-8">
          <h1 className="text-xl font-semibold">Workspace not found</h1>
        </div>
      </AppShell>
    );
  }
  const canManage = ws.role === "admin" || ws.role === "owner";

  if (!env) {
    return (
      <AppShell
        breadcrumbs={[
          { label: workspaceSlug, href: `/workspaces/${workspaceSlug}/` },
          {
            label: "Environments",
            href: `/workspaces/${workspaceSlug}/environments`,
          },
          { label: "…" },
        ]}
      >
        <div className="p-8 text-sm text-fg-muted">Loading…</div>
      </AppShell>
    );
  }

  const onSaveTitle = async () => {
    if (!renameValue.trim() || renameValue.trim() === env.title) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rename(workspaceSlug, env.id, renameValue.trim());
      setRenaming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onConfirmDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await remove(workspaceSlug, env.id);
      window.location.href = `/workspaces/${workspaceSlug}/environments`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}/` },
        {
          label: "Environments",
          href: `/workspaces/${workspaceSlug}/environments`,
        },
        { label: env.slug },
      ]}
    >
      <div className="mx-auto max-w-3xl space-y-8 px-6 pt-8 pb-12">
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            {renaming ? (
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => onSaveTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveTitle();
                  if (e.key === "Escape") setRenaming(false);
                }}
                autoFocus
                disabled={busy}
                className="w-full rounded-md border border-border-soft bg-bg-elevated px-3 py-1.5 text-2xl font-semibold text-fg focus:border-accent focus:outline-none"
              />
            ) : (
              <>
                <h1 className="text-2xl font-semibold tracking-tight text-fg">
                  {env.title}
                </h1>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    className="text-xs text-fg-muted hover:text-fg"
                  >
                    Rename
                  </button>
                )}
              </>
            )}
            <StatusPill status={env.last_deploy_status} />
          </div>
          <p className="text-sm text-fg-muted">
            <code className="text-fg">{env.slug}</code>
            <span className="mx-1.5">·</span>
            {env.repo_full_name}
            <span className="mx-1.5">·</span>
            {env.branch}
          </p>
        </header>

        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {env.last_deploy_url && env.last_deploy_status === "ready" && (
          <a
            href={env.last_deploy_url}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:bg-accent/90"
          >
            Open preview →
          </a>
        )}
        {env.last_deploy_status === "failed" && env.last_deploy_status_reason && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            <p className="font-medium">Last deploy failed</p>
            <p className="mt-1 text-red-300">{env.last_deploy_status_reason}</p>
          </div>
        )}

        <section className="grid gap-4 rounded-lg border border-border-soft bg-bg-elevated/30 p-5 sm:grid-cols-2">
          <Field label="URL">
            {env.last_deploy_url ? (
              <a
                href={env.last_deploy_url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-accent hover:underline"
              >
                {env.last_deploy_url}
              </a>
            ) : (
              <span className="text-fg-muted">—</span>
            )}
          </Field>
          <Field label="Commit">
            {env.last_deploy_sha ? (
              <code>{env.last_deploy_sha.slice(0, 12)}</code>
            ) : (
              <span className="text-fg-muted">—</span>
            )}
          </Field>
          <Field label="Branch">{env.branch}</Field>
          <Field label="Repo">{env.repo_full_name}</Field>
          <Field label="Image">
            {env.last_deploy_image_ref ? (
              <code className="break-all">{env.last_deploy_image_ref}</code>
            ) : (
              <span className="text-fg-muted">—</span>
            )}
          </Field>
          <Field label="Last deploy">
            {env.last_deploy_at
              ? new Date(env.last_deploy_at).toLocaleString()
              : "never"}
          </Field>
          <Field label="Created">
            {new Date(env.created_at).toLocaleString()}
          </Field>
          <Field label="Updated">
            {new Date(env.updated_at).toLocaleString()}
          </Field>
        </section>

        <EnvVarsSection
          slug={workspaceSlug}
          envId={env.id}
          selected={env.env_var_names ?? []}
          canManage={canManage}
          onSave={async (names) => {
            await setEnvVarNames(workspaceSlug, env.id, names);
          }}
        />

        <AliasHostsSection
          slug={workspaceSlug}
          envId={env.id}
          aliasHosts={env.alias_hosts ?? []}
          previewUrl={env.last_deploy_url}
          canManage={canManage}
        />

        {canManage && (
          <section className="space-y-3 rounded-lg border border-red-500/30 bg-red-500/5 p-5">
            <h2 className="text-sm font-semibold text-red-300">Danger zone</h2>
            {confirmDelete ? (
              <div className="space-y-3 text-sm text-fg-muted">
                <p>
                  Delete <strong className="text-fg">{env.title}</strong> ({env.slug})?
                  This tears down the cluster Deployment, Service, Ingress, and
                  any per-preview Secret. The slot is gone; an agent running{" "}
                  <code className="rounded bg-bg-elevated px-1">
                    preview_deploy
                  </code>{" "}
                  with the same slug will recreate it.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onConfirmDelete}
                    className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {busy ? "Deleting…" : "Yes, delete"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-md border border-border-soft px-3 py-1.5 text-sm text-fg hover:bg-bg-elevated"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center rounded-md border border-red-500/60 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-500/20 hover:text-red-100"
              >
                Delete environment
              </button>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}

import {
  useWorkspaceEnvBindingsStore,
  type WorkspaceEnvBindingDTO,
} from "../../stores/workspaceEnvBindingsStore";
import { EnvBindingForm } from "../workspaces/EnvBindingForm";

const EMPTY_BINDINGS: WorkspaceEnvBindingDTO[] = [];

interface EnvVarsSectionProps {
  slug: string;
  envId: string;
  selected: string[];
  canManage: boolean;
  onSave: (names: string[]) => Promise<void>;
}

function EnvVarsSection({
  slug,
  envId,
  selected,
  canManage,
  onSave,
}: EnvVarsSectionProps) {
  void envId;
  const bindings = useWorkspaceEnvBindingsStore(
    (s) => s.byWorkspace[slug] ?? EMPTY_BINDINGS,
  );
  const bindingsStatus = useWorkspaceEnvBindingsStore(
    (s) => s.status[slug] ?? "idle",
  );
  const loadBindings = useWorkspaceEnvBindingsStore(
    (s) => s.loadForWorkspace,
  );
  const setBinding = useWorkspaceEnvBindingsStore((s) => s.set);
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Lets the operator open an inline add-binding form without
  // leaving the Environment detail page (X1A request: "why aren't
  // the variables linked in the environments admin?").
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (bindingsStatus === "idle") loadBindings(slug);
  }, [bindingsStatus, slug, loadBindings]);
  useEffect(() => {
    setPicked(new Set(selected));
  }, [selected.join(",")]);

  const dirty =
    picked.size !== selected.length ||
    selected.some((n) => !picked.has(n));

  const toggle = (name: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave([...picked]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border-soft bg-bg-elevated/30 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Env vars to expose</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Workspace env-var aliases this preview opts into. Selected
            names land in the per-preview pod's env (resolved against
            workspace secrets at deploy time).
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canManage && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
            >
              + Expose a secret here
            </button>
          )}
          {canManage && dirty && (
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
      {err && <p className="text-sm text-red-300">{err}</p>}
      {adding && canManage && (
        <div className="rounded-md border border-border-soft bg-bg-elevated/40 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-fg-muted">
              Pick a workspace secret to expose, or create one inline.
              The new alias appears in the list below; tick it to
              expose it to this preview.
            </p>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs text-fg-faint hover:text-fg"
            >
              Close
            </button>
          </div>
          <EnvBindingForm
            slug={slug}
            submitLabel="Expose"
            alreadyBoundSecretNames={bindings.map((b) => b.secret_name)}
            onSubmit={async (envName, secretName) => {
              await setBinding(slug, envName, secretName);
              setPicked((prev) => {
                const next = new Set(prev);
                next.add(envName);
                return next;
              });
            }}
          />
        </div>
      )}
      {bindings.length === 0 && !adding ? (
        <p className="text-sm text-fg-muted">
          No workspace secrets are exposed to this preview yet. Click
          "+ Expose a secret here" to pick one (or create one inline)
          and tick it below to roll into the next deploy.
        </p>
      ) : bindings.length > 0 ? (
        <ul className="space-y-1.5">
          {bindings.map((b) => (
            <li key={b.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-bg-elevated">
                <input
                  type="checkbox"
                  checked={picked.has(b.env_name)}
                  disabled={!canManage}
                  onChange={() => toggle(b.env_name)}
                  className="size-4 rounded border-border-soft"
                />
                <span className="font-mono text-sm text-fg">{b.env_name}</span>
                <span className="text-xs text-fg-faint">
                  ← secret:{b.secret_name}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface AliasHostsSectionProps {
  slug: string;
  envId: string;
  aliasHosts: string[];
  previewUrl: string | null;
  canManage: boolean;
}

/**
 * Custom hostnames the preview also answers on. Operators register a
 * vanity domain (e.g. `app.<their-domain>.com`) here after pointing
 * its DNS at the cluster ingress. The next deploy emits an Ingress
 * rule + per-alias TLS entry, and cert-manager provisions a Let's
 * Encrypt cert via HTTP-01 automatically.
 *
 * Validation is server-side: the API rejects hosts on the install's
 * reserved domains, so a workspace admin can't shadow platform
 * traffic with an alias. Bad hostnames surface as a 400 with a
 * specific error code we render inline.
 */
function AliasHostsSection({
  slug,
  envId,
  aliasHosts,
  previewUrl,
  canManage,
}: AliasHostsSectionProps) {
  const setAliasHosts = usePreviewEnvironmentsStore((s) => s.setAliasHosts);
  const [adding, setAdding] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const previewHost = (() => {
    if (!previewUrl) return null;
    try {
      return new URL(previewUrl).host;
    } catch {
      return null;
    }
  })();

  const onAdd = async () => {
    const target = newHost.trim().toLowerCase();
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      await setAliasHosts(slug, envId, [...aliasHosts, target]);
      setNewHost("");
      setAdding(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (host: string) => {
    setBusy(true);
    setErr(null);
    try {
      await setAliasHosts(slug, envId, aliasHosts.filter((h) => h !== host));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border-soft bg-bg-elevated/30 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">Custom hostnames</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Extra hostnames this preview answers on. The platform emits one
            Ingress rule + a cert-manager-issued TLS cert per alias on the
            next deploy. You handle DNS — CNAME or A-record the host at the
            cluster's ingress before adding it.
            {previewHost ? (
              <>
                {" "}For this install:{" "}
                <code className="rounded bg-bg-elevated px-1">{previewHost}</code>{" "}
                is the canonical name.
              </>
            ) : null}
          </p>
        </div>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setErr(null);
            }}
            className="shrink-0 rounded-md border border-border-soft px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
          >
            + Add hostname
          </button>
        )}
      </div>

      {adding && canManage && (
        <div className="rounded-md border border-border-soft bg-bg-elevated/40 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-faint">host:</span>
            <input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value.toLowerCase())}
              placeholder="app.example.com"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void onAdd();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewHost("");
                  setErr(null);
                }
              }}
              className="w-72 rounded-md border border-border-soft bg-bg-elevated px-2 py-1 font-mono text-sm text-fg focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={onAdd}
              disabled={busy || !newHost.trim()}
              className="rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setNewHost("");
                setErr(null);
              }}
              disabled={busy}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-fg-faint">
            Bare hostname (no scheme, no port, no path). The API refuses
            hosts on the install's reserved domains.
          </p>
        </div>
      )}

      {err && <p className="text-sm text-red-300">{err}</p>}

      {aliasHosts.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No custom hostnames. Click "+ Add hostname" to register one.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {aliasHosts.map((h) => (
            <li
              key={h}
              className="flex items-center justify-between gap-2 rounded-md border border-border-soft bg-bg-elevated/40 px-3 py-2 text-sm"
            >
              <code className="text-fg">{h}</code>
              {canManage && (
                <button
                  type="button"
                  onClick={() => void onRemove(h)}
                  disabled={busy}
                  className="text-xs text-red-300 hover:text-red-200"
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
