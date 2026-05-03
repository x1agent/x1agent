import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";

/**
 * Workspace MCP catalog panel.
 *
 * Workspace admins register MCP server images here, paste the
 * manifest declaring env vars + tool scopes, and agents in this
 * workspace then attach to the entries via the agent edit screen.
 *
 * v1: manifest is paste-only. v2 fetches /mcp-manifest.json from the
 * image at registration time.
 */

interface CatalogEntry {
  id: string;
  name: string;
  display_name: string | null;
  image: string;
  manifest: {
    env: Record<
      string,
      { kind: "secret" | "value"; label?: string; required?: boolean; description?: string }
    >;
    tool_scopes: Record<string, string[]>;
  };
  description: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface Props {
  slug: string;
  canManage: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const EXAMPLE_MANIFEST = `{
  "env": {
    "API_KEY": { "kind": "secret", "label": "API key", "required": true }
  },
  "tool_scopes": {
    "list_items": ["read"],
    "create_item": ["write"]
  }
}`;

export function WorkspaceMcpCatalogPanel({ slug, canManage }: Props) {
  const [items, setItems] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CatalogEntry | null>(null);

  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<{ entries: CatalogEntry[] }>(
        `/api/workspaces/${slug}/mcp-catalog`,
      );
      setItems(r.entries);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canManage) void load();
  }, [slug, canManage]);

  function resetForm() {
    setName("");
    setDisplayName("");
    setImage("");
    setDescription("");
    setManifestText("");
    setEditing(null);
  }

  function startEdit(row: CatalogEntry) {
    setEditing(row);
    setName(row.name);
    setDisplayName(row.display_name ?? "");
    setImage(row.image);
    setDescription(row.description);
    setManifestText(JSON.stringify(row.manifest, null, 2));
    setTimeout(() => {
      document.getElementById("mcp-image")?.focus();
    }, 0);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setError(null);
    if (!NAME_RE.test(name)) {
      setError(
        "Name must be lowercase letters, digits, hyphens, underscores; start with a letter.",
      );
      return;
    }
    if (image.trim().length === 0) {
      setError("Image is required.");
      return;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText || "{}");
    } catch {
      setError("Manifest must be valid JSON.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/api/workspaces/${slug}/mcp-catalog`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          display_name: displayName.trim() || null,
          image: image.trim(),
          manifest,
          description,
        }),
      });
      resetForm();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(row: CatalogEntry) {
    if (!canManage) return;
    if (!confirm(`Remove ${row.name} from the catalog?`)) return;
    setError(null);
    try {
      await apiFetch(`/api/workspaces/${slug}/mcp-catalog/${row.id}`, {
        method: "DELETE",
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!canManage) {
    return (
      <Card className="mt-4">
        <CardContent className="py-4 text-sm text-zinc-500">
          Only workspace admins and owners can manage the MCP catalog.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>MCP servers</CardTitle>
          <CardDescription>
            Registered MCP server images. Agents in this workspace can
            attach to any of these from their edit screen. Plaintext for
            secret-kind env values stays in the MCP container — the
            agent never sees it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <div className="text-sm text-zinc-500">Loading…</div>}
          {!loading && items.length === 0 && (
            <div className="text-sm text-zinc-500">
              No MCP servers registered yet. Add one below.
            </div>
          )}
          {!loading && items.length > 0 && (
            <ul className="divide-y divide-zinc-800">
              {items.map((row) => (
                <li key={row.id} className="flex items-start justify-between py-3">
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-zinc-100">
                      {row.name}
                      {row.display_name && (
                        <span className="ml-2 font-sans text-xs text-zinc-400">
                          {row.display_name}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-xs text-zinc-500">
                      {row.image}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {Object.keys(row.manifest.env).map((k) => (
                        <Badge key={k} variant="outline" className="text-xs">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(row)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onDelete(row)}
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
            {editing ? `Edit ${editing.name}` : "Register MCP server"}
          </CardTitle>
          <CardDescription>
            Paste the manifest published by the MCP image. Names follow
            the mcpServers convention: lowercase letters, digits,
            hyphens, underscores; start with a letter.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-name">Name</Label>
                <Input
                  id="mcp-name"
                  required
                  value={name}
                  disabled={!!editing}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  placeholder="linear"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-display">Display name (optional)</Label>
                <Input
                  id="mcp-display"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Linear"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-image">Image</Label>
              <Input
                id="mcp-image"
                required
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="ghcr.io/org/linear-mcp:1.2.0"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-desc">Description (optional)</Label>
              <Input
                id="mcp-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line summary of what this MCP exposes"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-manifest">Manifest</Label>
              <Textarea
                id="mcp-manifest"
                required
                value={manifestText}
                onChange={(e) => setManifestText(e.target.value)}
                placeholder={EXAMPLE_MANIFEST}
                rows={12}
                className="font-mono text-xs"
                spellCheck={false}
              />
              <p className="text-xs text-zinc-500">
                JSON object with <code>env</code> and <code>tool_scopes</code>.
                See your MCP image's docs for the manifest contents.
              </p>
            </div>
            {error && <div className="text-sm text-red-400">{error}</div>}
            <div className="flex items-center gap-2 pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting
                  ? "Saving…"
                  : editing
                    ? "Save changes"
                    : "Register"}
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetForm}
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
