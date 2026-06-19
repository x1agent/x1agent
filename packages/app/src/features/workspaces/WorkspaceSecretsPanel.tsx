import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useConfirm } from "../../components/use-confirm";
import {
  useWorkspaceEnvBindingsStore,
  type WorkspaceEnvBindingDTO,
} from "../../stores/workspaceEnvBindingsStore";

/**
 * Workspace secrets — single source of truth for both the encrypted
 * value AND the env-var aliases that expose it to agents and preview
 * environments.
 *
 * The data layer keeps two tables (workspace_secrets,
 * env_bindings), but operators almost always think of them as one
 * concept ("I have an API key, expose it under this env var name").
 * This panel collapses them into one UI: each secret row owns its
 * bindings inline, with a default-on "Expose under same name" toggle
 * on the create form so the 95% case is one form submission.
 *
 * Multi-alias is still supported — add an extra binding to a secret
 * by editing its env-var name to something different and saving.
 * The standalone Env-var aliases panel remains routable for backward
 * compatibility but is no longer the recommended entry point.
 */

interface SecretRow {
  id: string;
  name: string;
  is_set: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

interface Props {
  slug: string;
  canManage: boolean;
}

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const EMPTY_BINDINGS: WorkspaceEnvBindingDTO[] = [];

export function WorkspaceSecretsPanel({ slug, canManage }: Props) {
  const [items, setItems] = useState<SecretRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [exposeAsEnv, setExposeAsEnv] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const bindings = useWorkspaceEnvBindingsStore(
    (s) => s.byWorkspace[slug] ?? EMPTY_BINDINGS,
  );
  const bindingsStatus = useWorkspaceEnvBindingsStore(
    (s) => s.status[slug] ?? "idle",
  );
  const loadBindings = useWorkspaceEnvBindingsStore((s) => s.loadForWorkspace);
  const setBinding = useWorkspaceEnvBindingsStore((s) => s.set);
  const removeBinding = useWorkspaceEnvBindingsStore((s) => s.remove);

  const bindingsBySecret = useMemo(() => {
    const out = new Map<string, WorkspaceEnvBindingDTO[]>();
    for (const b of bindings) {
      const arr = out.get(b.secret_name) ?? [];
      arr.push(b);
      out.set(b.secret_name, arr);
    }
    return out;
  }, [bindings]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<{ secrets: SecretRow[] }>(
        `/api/workspaces/${slug}/secrets`,
      );
      setItems(r.secrets);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canManage) return;
    void load();
    if (bindingsStatus === "idle") void loadBindings(slug);
  }, [slug, canManage, bindingsStatus, loadBindings]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setError(null);
    if (!NAME_RE.test(name)) {
      setError(
        "Name must be uppercase letters, digits, and underscores; 1–64 chars; start with a letter or underscore.",
      );
      return;
    }
    if (value.length === 0) {
      setError("Value cannot be empty.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/api/workspaces/${slug}/secrets/${name}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      // If creating a new secret AND the "expose" toggle is on, mint
      // the default-shape env binding in the same submit. Rotation
      // (editingName != null) doesn't touch bindings.
      if (!editingName && exposeAsEnv) {
        try {
          await setBinding(slug, name, name);
        } catch (bindingErr) {
          // The secret is already saved; surface the binding error
          // without rolling back. The operator can add the binding
          // manually from the row's "Expose to agents and previews"
          // action if this fails.
          console.warn(
            "[workspace-secrets] auto-expose failed:",
            (bindingErr as Error).message,
          );
        }
      }
      setName("");
      setValue("");
      setEditingName(null);
      setExposeAsEnv(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(rowName: string) {
    if (!canManage) return;
    const linked = bindingsBySecret.get(rowName) ?? [];
    const ok = await confirm({
      title: `Delete secret ${rowName}?`,
      description:
        linked.length > 0
          ? `${linked.length} env-var alias${linked.length === 1 ? "" : "es"} reference this secret and will stop resolving. This cannot be undone.`
          : "This cannot be undone.",
      confirmText: "Delete",
    });
    if (!ok) return;
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${slug}/secrets/${rowName}`, {
        method: "DELETE",
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function startRotate(rowName: string) {
    setEditingName(rowName);
    setName(rowName);
    setValue("");
    setExposeAsEnv(false);
    setTimeout(() => {
      const el = document.getElementById("secret-value");
      el?.focus();
    }, 0);
  }

  function cancelEdit() {
    setEditingName(null);
    setName("");
    setValue("");
    setExposeAsEnv(true);
  }

  if (!canManage) {
    return (
      <Card className="mt-4">
        <CardContent className="py-4 text-sm text-fg-faint">
          Only workspace admins and owners can manage workspace secrets.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {dialog}
      <Card>
        <CardHeader>
          <CardTitle>Workspace secrets</CardTitle>
          <CardDescription>
            Named encrypted values used by MCP servers, siblings, runtime
            services, agent sessions, and preview environments. MCP and
            sibling configs reference them with <code className="rounded bg-bg-muted px-1">{"${NAME}"}</code> template
            syntax. To expose a secret as an env var inside agent pods or
            preview environments, add the env-var alias directly under
            the secret. Values are encrypted at rest and never returned
            by the API — rotate by setting again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="text-sm text-fg-faint">Loading…</div>
          )}
          {!loading && items.length === 0 && (
            <div className="text-sm text-fg-faint">
              No workspace secrets yet. Add one below.
            </div>
          )}
          {!loading && items.length > 0 && (
            <ul className="divide-y divide-border-soft">
              {items.map((row) => (
                <SecretRowItem
                  key={row.id}
                  slug={slug}
                  row={row}
                  bindings={bindingsBySecret.get(row.name) ?? EMPTY_BINDINGS}
                  onRotate={() => startRotate(row.name)}
                  onDelete={() => onDelete(row.name)}
                  setBinding={setBinding}
                  removeBinding={removeBinding}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {editingName ? `Rotate ${editingName}` : "Add workspace secret"}
          </CardTitle>
          <CardDescription>
            Names follow the bare-reference syntax: uppercase letters,
            digits, and underscores. 1–64 characters; must start with
            a letter or underscore.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                required
                value={name}
                disabled={!!editingName}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="MY_API_KEY"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="secret-value">Value</Label>
              <Input
                id="secret-value"
                required
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={editingName ? "Enter new value" : ""}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-fg-faint">
                Stored encrypted at rest. The plaintext value is never
                returned by any API endpoint.
              </p>
            </div>
            {!editingName && (
              <label className="flex items-start gap-2 pt-1 text-sm text-fg-muted">
                <input
                  type="checkbox"
                  checked={exposeAsEnv}
                  onChange={(e) => setExposeAsEnv(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-border-soft"
                />
                <span>
                  Expose this secret as an env var under the same name.
                  Agents and preview environments can opt in on their
                  detail pages. You can edit or remove this exposure
                  later from the secret's row above.
                </span>
              </label>
            )}
            {error && (
              <div className="text-sm text-red-400">{error}</div>
            )}
            <div className="flex items-center gap-2 pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting
                  ? "Saving…"
                  : editingName
                    ? "Rotate"
                    : "Add secret"}
              </Button>
              {editingName && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={cancelEdit}
                  disabled={submitting}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

interface SecretRowItemProps {
  slug: string;
  row: SecretRow;
  bindings: readonly WorkspaceEnvBindingDTO[];
  onRotate(): void;
  onDelete(): void;
  setBinding(
    slug: string,
    envName: string,
    secretName: string,
  ): Promise<void>;
  removeBinding(slug: string, envName: string): Promise<void>;
}

function SecretRowItem({
  slug,
  row,
  bindings,
  onRotate,
  onDelete,
  setBinding,
  removeBinding,
}: SecretRowItemProps) {
  // Local UI state for an in-row "expose" / "rename" pane. Lives on
  // the row so multiple rows can each have an open editor without
  // colliding through a parent-owned single editor slot.
  const [adding, setAdding] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  // Rename mode for an existing binding — keyed by binding id so
  // the user can rename one alias without opening editors on the
  // others. We model it as the binding id we're editing + the
  // pending env-var name; null means no edit in progress.
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    oldEnvName: string;
    newEnvName: string;
  } | null>(null);

  const submitAdd = async () => {
    const target = newEnvName.trim().toUpperCase();
    if (!NAME_RE.test(target)) {
      setRowError(
        "Env-var name must be uppercase letters, digits, and underscores; 1–64 chars; start with a letter or underscore.",
      );
      return;
    }
    setBusy(true);
    setRowError(null);
    try {
      await setBinding(slug, target, row.name);
      setAdding(false);
      setNewEnvName("");
    } catch (err) {
      setRowError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const target = renameTarget.newEnvName.trim().toUpperCase();
    if (!NAME_RE.test(target)) {
      setRowError(
        "Env-var name must be uppercase letters, digits, and underscores; 1–64 chars.",
      );
      return;
    }
    if (target === renameTarget.oldEnvName) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    setRowError(null);
    try {
      // No direct rename endpoint — set the new env-var name (creates
      // a fresh row) and then remove the old name. If the second
      // call fails we end up with both; the operator can clean up
      // from the row.
      await setBinding(slug, target, row.name);
      await removeBinding(slug, renameTarget.oldEnvName);
      setRenameTarget(null);
    } catch (err) {
      setRowError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (envName: string) => {
    setBusy(true);
    setRowError(null);
    try {
      await removeBinding(slug, envName);
    } catch (err) {
      setRowError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-sm text-fg">{row.name}</div>
          <div className="text-xs text-fg-faint">
            Updated {new Date(row.updated_at).toLocaleString()}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {row.is_set ? "set" : "unset"}
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={onRotate}>
            Rotate
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      <div className="ml-3 border-l border-border-soft pl-3 space-y-1">
        {bindings.length === 0 && !adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setNewEnvName(row.name);
              setRowError(null);
            }}
            className="text-xs text-accent hover:underline"
          >
            + Expose to agents and preview environments
          </button>
        )}

        {bindings.map((b) =>
          renameTarget?.id === b.id ? (
            <div key={b.id} className="flex items-center gap-2">
              <span className="text-xs text-fg-faint">env var:</span>
              <input
                value={renameTarget.newEnvName}
                onChange={(e) =>
                  setRenameTarget({
                    ...renameTarget,
                    newEnvName: e.target.value.toUpperCase(),
                  })
                }
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitRename();
                  if (e.key === "Escape") setRenameTarget(null);
                }}
                className="w-56 rounded-md border border-border-soft bg-bg-elevated px-2 py-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void submitRename()}
                disabled={busy}
              >
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRenameTarget(null)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div
              key={b.id}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="font-mono text-fg-muted">
                exposed as env var:{" "}
                <span className="text-fg">{b.env_name}</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setRenameTarget({
                      id: b.id,
                      oldEnvName: b.env_name,
                      newEnvName: b.env_name,
                    })
                  }
                  className="text-fg-faint hover:text-fg"
                  disabled={busy}
                >
                  rename
                </button>
                <button
                  type="button"
                  onClick={() => void removeOne(b.env_name)}
                  className="text-red-300 hover:text-red-200"
                  disabled={busy}
                >
                  remove
                </button>
              </div>
            </div>
          ),
        )}

        {(bindings.length > 0 || adding) && bindings.length < 5 && !adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setNewEnvName("");
              setRowError(null);
            }}
            className="text-xs text-accent hover:underline"
          >
            + Expose under another env-var name
          </button>
        )}

        {adding && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-fg-faint">env var:</span>
            <input
              value={newEnvName}
              onChange={(e) => setNewEnvName(e.target.value.toUpperCase())}
              placeholder={row.name}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitAdd();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewEnvName("");
                }
              }}
              className="w-56 rounded-md border border-border-soft bg-bg-elevated px-2 py-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void submitAdd()}
              disabled={busy || !newEnvName.trim()}
            >
              Expose
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(false);
                setNewEnvName("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        )}

        {rowError && <p className="text-xs text-red-300">{rowError}</p>}
      </div>
    </li>
  );
}
