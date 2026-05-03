import { useEffect, useState } from "react";
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

/**
 * Workspace environment variables / secrets panel.
 *
 * Lists secret names + last-updated metadata. The plaintext value is
 * never returned by any API endpoint — operators rotate by setting the
 * value again. The reference syntax is `${SECRET_NAME}` everywhere it's
 * consumed (MCP attachments, sibling env, runtime services).
 *
 * v1: values are AES-256-GCM-encrypted at rest in Postgres with a
 * deployment-wide master key. v2 (target): values land in per-workspace
 * Kubernetes Secrets and the API only writes the secret-ref. See
 * docs/providers/mcp-servers.md.
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

export function WorkspaceSecretsPanel({ slug, canManage }: Props) {
  const [items, setItems] = useState<SecretRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);

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
    if (canManage) void load();
  }, [slug, canManage]);

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
      setName("");
      setValue("");
      setEditingName(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(rowName: string) {
    if (!canManage) return;
    if (!confirm(`Delete secret ${rowName}? This cannot be undone.`)) return;
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
    // Scroll the form into view.
    setTimeout(() => {
      const el = document.getElementById("secret-value");
      el?.focus();
    }, 0);
  }

  function cancelEdit() {
    setEditingName(null);
    setName("");
    setValue("");
  }

  if (!canManage) {
    return (
      <Card className="mt-4">
        <CardContent className="py-4 text-sm text-zinc-500">
          Only workspace admins and owners can manage environment variables.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Environment variables</CardTitle>
          <CardDescription>
            Named values that MCP servers, siblings, and runtime services
            reference via <code className="rounded bg-zinc-800 px-1">{"${NAME}"}</code> template syntax.
            Values are encrypted at rest and never returned by the API —
            rotate by setting again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="text-sm text-zinc-500">Loading…</div>
          )}
          {!loading && items.length === 0 && (
            <div className="text-sm text-zinc-500">
              No environment variables yet. Add one below.
            </div>
          )}
          {!loading && items.length > 0 && (
            <ul className="divide-y divide-zinc-800">
              {items.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between py-3"
                >
                  <div>
                    <div className="font-mono text-sm text-zinc-100">
                      {row.name}
                    </div>
                    <div className="text-xs text-zinc-500">
                      Updated {new Date(row.updated_at).toLocaleString()}
                      {row.updated_by ? "" : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {row.is_set ? "set" : "unset"}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => startRotate(row.name)}
                    >
                      Rotate
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onDelete(row.name)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {editingName ? `Rotate ${editingName}` : "Add environment variable"}
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
              <p className="text-xs text-zinc-500">
                Stored encrypted at rest. The plaintext value is never
                returned by any API endpoint.
              </p>
            </div>
            {error && (
              <div className="text-sm text-red-400">{error}</div>
            )}
            <div className="flex items-center gap-2 pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting
                  ? "Saving…"
                  : editingName
                    ? "Rotate"
                    : "Add variable"}
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
