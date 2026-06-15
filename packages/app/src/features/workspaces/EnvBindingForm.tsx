import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useWorkspaceSecretsStore } from "../../stores/workspaceSecretsStore";

/**
 * Shared "create a workspace env binding" form. Used both in the
 * Bindings panel under workspace settings and inline on the
 * Environment detail page so operators don't have to bounce to
 * Settings to mint a binding for the preview they're already on.
 *
 * Behaviour rules baked in here so callers don't drift:
 *   - The Secret field is a Select over existing workspace_secrets,
 *     never freeform — historically freeform meant a binding could
 *     silently point at a non-existent secret name.
 *   - Picking a secret auto-fills the env-var name with the same
 *     string (the 95% case). Operators can edit it before submitting
 *     if they want a different alias.
 *   - A "+ Create new secret" option opens an inline new-secret
 *     create panel; on success the new name is auto-selected.
 *
 * The form does NOT persist by itself — onSubmit owns that, so this
 * component works whether the consumer wants store.set() (the
 * Bindings panel) or a one-shot set-then-opt-in (Environment detail).
 */
export interface EnvBindingFormProps {
  slug: string;
  onSubmit(envName: string, secretName: string): Promise<void>;
  submitLabel?: string;
  /**
   * Optional names already bound — used to dim them in the secret
   * picker since binding the same secret twice under different
   * env-var names is allowed but uncommon and worth a visual nudge.
   */
  alreadyBoundSecretNames?: readonly string[];
}

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function EnvBindingForm({
  slug,
  onSubmit,
  submitLabel = "Add binding",
  alreadyBoundSecretNames = [],
}: EnvBindingFormProps) {
  const secrets = useWorkspaceSecretsStore(
    (s) => s.byWorkspace[slug] ?? EMPTY,
  );
  const loadSecrets = useWorkspaceSecretsStore((s) => s.load);
  const setSecretValue = useWorkspaceSecretsStore((s) => s.setValue);

  const [envName, setEnvName] = useState("");
  const [secretName, setSecretName] = useState("");
  // True when the operator hasn't yet edited the env-var field
  // by hand — in that case picking a new secret keeps overwriting
  // envName. Once they edit, we stop clobbering their choice.
  const [envNameAutoSynced, setEnvNameAutoSynced] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline new-secret pane state
  const [creating, setCreating] = useState(false);
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [creatingError, setCreatingError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  useEffect(() => {
    void loadSecrets(slug);
  }, [slug, loadSecrets]);

  const onPickSecret = (next: string) => {
    if (next === SENTINEL_CREATE) {
      setCreating(true);
      return;
    }
    setSecretName(next);
    if (envNameAutoSynced) setEnvName(next);
  };

  const onEnvNameChange = (raw: string) => {
    const upper = raw.toUpperCase();
    setEnvName(upper);
    // The operator started typing — stop overriding their input on
    // the next secret pick.
    if (envNameAutoSynced && upper !== secretName) setEnvNameAutoSynced(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!envName.trim() || !secretName.trim()) return;
    if (!NAME_RE.test(envName.trim())) {
      setError(
        "Env-var name must be uppercase letters, digits, and underscores; 1–64 chars; start with a letter or underscore.",
      );
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(envName.trim(), secretName.trim());
      // Reset so the form is ready for the next add; keep the secret
      // picker in sync with the new auto-sync state.
      setEnvName("");
      setSecretName("");
      setEnvNameAutoSynced(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const createSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingError(null);
    if (!NAME_RE.test(newSecretName)) {
      setCreatingError(
        "Name must be uppercase letters, digits, and underscores; 1–64 chars; start with a letter or underscore.",
      );
      return;
    }
    if (newSecretValue.length === 0) {
      setCreatingError("Value cannot be empty.");
      return;
    }
    setCreatingBusy(true);
    try {
      await setSecretValue(slug, {
        name: newSecretName,
        value: newSecretValue,
      });
      // Auto-select the new secret + auto-fill env-var name.
      setSecretName(newSecretName);
      if (envNameAutoSynced) setEnvName(newSecretName);
      setNewSecretName("");
      setNewSecretValue("");
      setCreating(false);
    } catch (err) {
      setCreatingError((err as Error).message);
    } finally {
      setCreatingBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">
            Workspace secret
          </label>
          <Select value={secretName} onValueChange={onPickSecret}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a workspace secret" />
            </SelectTrigger>
            <SelectContent>
              {secrets.length === 0 ? (
                <SelectItem value="__none" disabled>
                  No workspace secrets yet
                </SelectItem>
              ) : (
                secrets.map((s) => (
                  <SelectItem key={s.id} value={s.name}>
                    {s.name}
                    {alreadyBoundSecretNames.includes(s.name) ? (
                      <span className="ml-2 text-xs text-fg-faint">
                        (already bound)
                      </span>
                    ) : null}
                  </SelectItem>
                ))
              )}
              <SelectItem value={SENTINEL_CREATE} className="text-accent">
                + Create new secret…
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-fg-faint">
            The stored value (never returned by the API).
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">
            Env-var name
          </label>
          <input
            value={envName}
            onChange={(e) => onEnvNameChange(e.target.value)}
            placeholder={secretName || "ANTHROPIC_API_KEY"}
            autoComplete="off"
            className="w-full rounded-md border border-border-soft bg-bg-elevated px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
          <p className="mt-1 text-xs text-fg-faint">
            What <code>process.env</code> sees inside the pod.
            {envNameAutoSynced ? " Defaults to the secret name." : null}
          </p>
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={submitting || !envName.trim() || !secretName.trim()}
            className="rounded-md bg-fg px-3 py-2 text-sm font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
          >
            {submitting ? "Adding…" : submitLabel}
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}

      {creating && (
        <div className="rounded-md border border-border-soft bg-bg-elevated/40 p-3 space-y-2">
          <p className="text-xs text-fg-muted">
            New workspace secret — paste the actual value below. It's
            encrypted at rest and never returned by the API.
          </p>
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <input
              value={newSecretName}
              onChange={(e) =>
                setNewSecretName(e.target.value.toUpperCase())
              }
              placeholder="MY_API_KEY"
              autoComplete="off"
              className="rounded-md border border-border-soft bg-bg-elevated px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
            />
            <input
              type="password"
              value={newSecretValue}
              onChange={(e) => setNewSecretValue(e.target.value)}
              placeholder="Paste the value"
              autoComplete="off"
              className="rounded-md border border-border-soft bg-bg-elevated px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={createSecret}
                disabled={creatingBusy}
                className="rounded-md bg-fg px-3 py-2 text-sm font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
              >
                {creatingBusy ? "Saving…" : "Save secret"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setCreatingError(null);
                }}
                className="rounded-md border border-border-soft px-3 py-2 text-sm text-fg-muted"
              >
                Cancel
              </button>
            </div>
          </div>
          {creatingError && (
            <p className="text-sm text-red-300">{creatingError}</p>
          )}
        </div>
      )}
    </form>
  );
}

const EMPTY: never[] = [];
const SENTINEL_CREATE = "__create_new_secret__";
