import { useEffect, useState } from "react";
import { useWorkspaceEnvBindingsStore, type WorkspaceEnvBindingDTO } from "../../stores/workspaceEnvBindingsStore";

interface Props {
  slug: string;
  canManage: boolean;
}

const EMPTY: WorkspaceEnvBindingDTO[] = [];

/**
 * Workspace-scoped env var bindings.
 *
 * Each row maps an env-var name (what the consuming pod's process.env
 * sees) to a workspace_secret name (the value-of-record). Consumers:
 *   - agent sessions, when the agent's "env" tab opts into the binding
 *   - preview environments, when the env's env_var_names list opts in
 *
 * Bindings are NOT secrets themselves — they're stable references to
 * values stored in workspace_secrets. Rotating a secret value
 * propagates to every consumer on next session/preview start.
 */
export function WorkspaceEnvBindingsPanel({ slug, canManage }: Props) {
  const bindings = useWorkspaceEnvBindingsStore(
    (s) => s.byWorkspace[slug] ?? EMPTY,
  );
  const status = useWorkspaceEnvBindingsStore(
    (s) => s.status[slug] ?? "idle",
  );
  const error = useWorkspaceEnvBindingsStore(
    (s) => s.error[slug] ?? null,
  );
  const load = useWorkspaceEnvBindingsStore((s) => s.loadForWorkspace);
  const setBinding = useWorkspaceEnvBindingsStore((s) => s.set);
  const remove = useWorkspaceEnvBindingsStore((s) => s.remove);

  const [envName, setEnvName] = useState("");
  const [secretName, setSecretName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") load(slug);
  }, [status, slug, load]);

  if (status === "loading" || status === "idle") {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }
  if (status === "error") {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!envName.trim() || !secretName.trim()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await setBinding(slug, envName.trim(), secretName.trim());
      setEnvName("");
      setSecretName("");
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-fg">Workspace env bindings</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Map an env-var name to a workspace secret. Agents and preview
          environments opt into a binding by name; the secret value flows
          to the pod via a Kubernetes Secret reference — plaintext never
          appears in pod specs or this UI. Rotate the underlying secret
          to roll the value everywhere it's used.
        </p>
      </div>

      {canManage && (
        <form onSubmit={onAdd} className="rounded-lg border border-border-soft bg-bg-elevated/30 p-4 space-y-3">
          <h3 className="text-sm font-medium text-fg">Add binding</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div>
              <label className="block text-xs uppercase tracking-wide text-fg-muted mb-1">
                Env var
              </label>
              <input
                value={envName}
                onChange={(e) => setEnvName(e.target.value)}
                placeholder="DATABASE_URL"
                autoComplete="off"
                className="w-full rounded-md border border-border-soft bg-bg-elevated px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
              />
              <p className="mt-1 text-xs text-fg-faint">
                What <code>process.env</code> sees.
              </p>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-fg-muted mb-1">
                Secret
              </label>
              <input
                value={secretName}
                onChange={(e) => setSecretName(e.target.value)}
                placeholder="DATABASE_URL"
                autoComplete="off"
                className="w-full rounded-md border border-border-soft bg-bg-elevated px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
              />
              <p className="mt-1 text-xs text-fg-faint">
                Workspace secret name (case-insensitive).
              </p>
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={submitting || !envName.trim() || !secretName.trim()}
                className="rounded-md bg-fg px-3 py-2 text-sm font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
              >
                {submitting ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
          {formError && (
            <p className="text-sm text-red-300">{formError}</p>
          )}
        </form>
      )}

      {bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft p-6 text-sm text-fg-muted">
          No bindings yet. Add one above — for example
          {" "}<code className="rounded bg-bg-elevated px-1">DATABASE_URL → DATABASE_URL</code>{" "}
          (the env-var name and the secret name don't have to match, but
          they usually do).
        </div>
      ) : (
        <ul className="space-y-2">
          {bindings.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border-soft bg-bg-elevated/30 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-mono text-sm">
                  <span className="font-medium text-fg">{b.env_name}</span>
                  <span className="text-fg-faint">←</span>
                  <span className="text-fg-muted">secret:{b.secret_name}</span>
                </div>
                <div className="mt-0.5 text-xs text-fg-faint">
                  updated {new Date(b.updated_at).toLocaleString()}
                </div>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => remove(slug, b.env_name)}
                  className="shrink-0 text-sm text-red-300 hover:text-red-200"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
