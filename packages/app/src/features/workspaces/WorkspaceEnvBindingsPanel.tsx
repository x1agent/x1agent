import { useEffect } from "react";
import { useWorkspaceEnvBindingsStore, type WorkspaceEnvBindingDTO } from "../../stores/workspaceEnvBindingsStore";
import { EnvBindingForm } from "./EnvBindingForm";

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

  useEffect(() => {
    if (status === "idle") load(slug);
  }, [status, slug, load]);

  if (status === "loading" || status === "idle") {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }
  if (status === "error") {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-fg">Env-var aliases</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Expose a workspace secret to agents and preview environments
          under an env-var name they can opt into. The secret value flows
          to the pod via a Kubernetes Secret reference — plaintext never
          appears in pod specs or this UI. Rotate the underlying secret
          (under Workspace secrets) to roll the value everywhere it's used.
        </p>
      </div>

      {canManage && (
        <div className="rounded-lg border border-border-soft bg-bg-elevated/30 p-4 space-y-3">
          <h3 className="text-sm font-medium text-fg">Add alias</h3>
          <EnvBindingForm
            slug={slug}
            submitLabel="Add"
            alreadyBoundSecretNames={bindings.map((b) => b.secret_name)}
            onSubmit={(envName, secretName) =>
              setBinding(slug, envName, secretName)
            }
          />
        </div>
      )}

      {bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft p-6 text-sm text-fg-muted">
          No aliases yet. Pick a secret above and the env-var name will
          default to the same string — that's the right shape unless you
          need to expose the same value under a different name.
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
