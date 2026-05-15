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
                className="text-sm text-red-300 hover:text-red-200"
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
