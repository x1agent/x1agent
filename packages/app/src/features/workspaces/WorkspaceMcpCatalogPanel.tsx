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
import { useConfirm } from "../../components/use-confirm";
import {
  McpRegistryPicker,
  defaultsFromSeed,
} from "../mcp/McpRegistryPicker";
import { DEFAULT_MANIFEST } from "../mcp/seed";

/**
 * Workspace MCP catalog panel.
 *
 * Workspace admins register MCP servers here in one of two shapes:
 *   * Container image — published OCI ref (vendor maintains the image)
 *   * Command — npx / uvx / similar invocation that runs inside the
 *     platform's mcp-runner base image (matches Claude Desktop's
 *     claude.json shape)
 */

type Kind = "image" | "command" | "remote_oauth";

interface CatalogEntry {
  id: string;
  name: string;
  display_name: string | null;
  /** "stdio" | "remote_oauth" — server-side wire kind. */
  kind: "stdio" | "remote_oauth";
  image: string | null;
  command: string | null;
  args: string[];
  url: string | null;
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
  const [kind, setKind] = useState<Kind>("image");
  const [image, setImage] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState(""); // newline-separated for ergonomics
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { confirm, dialog } = useConfirm();

  /**
   * Apply a seed entry to the add-form. The operator gets a pre-
   * populated form they can then verify/edit before clicking Save.
   * Scrolls the form into view since the picker sits above the form
   * on long pages.
   */
  function applySeedEntry(seed: ReturnType<typeof defaultsFromSeed>) {
    setEditing(null);
    setName(seed.name);
    setDisplayName(seed.display_name);
    setKind(seed.kind);
    setImage(seed.image);
    setCommand(seed.command);
    setArgsText(seed.args);
    setUrl(seed.url);
    setDescription(seed.description);
    setManifestText(DEFAULT_MANIFEST);
    // Wait one tick so React commits state before we scroll, otherwise
    // we sometimes scroll before the form expands to its full height.
    setTimeout(() => {
      document
        .getElementById("mcp-add-form")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("mcp-name")?.focus();
    }, 0);
  }

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
    setKind("image");
    setImage("");
    setCommand("");
    setArgsText("");
    setUrl("");
    setDescription("");
    setManifestText("");
    setEditing(null);
  }

  function startEdit(row: CatalogEntry) {
    setEditing(row);
    setName(row.name);
    setDisplayName(row.display_name ?? "");
    if (row.kind === "remote_oauth") {
      setKind("remote_oauth");
      setImage("");
      setCommand("");
      setArgsText("");
      setUrl(row.url ?? "");
    } else if (row.image) {
      setKind("image");
      setImage(row.image);
      setCommand("");
      setArgsText("");
      setUrl("");
    } else {
      setKind("command");
      setImage("");
      setCommand(row.command ?? "");
      setArgsText(row.args.join("\n"));
      setUrl("");
    }
    setDescription(row.description);
    setManifestText(JSON.stringify(row.manifest, null, 2));
    setTimeout(() => {
      const id =
        row.kind === "remote_oauth"
          ? "mcp-url"
          : row.image
            ? "mcp-image"
            : "mcp-command";
      document.getElementById(id)?.focus();
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
    if (kind === "image" && image.trim().length === 0) {
      setError("Image is required.");
      return;
    }
    if (kind === "command" && command.trim().length === 0) {
      setError("Command is required.");
      return;
    }
    if (kind === "remote_oauth" && url.trim().length === 0) {
      setError("URL is required for a remote OAuth MCP.");
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
      const body: Record<string, unknown> = {
        name,
        display_name: displayName.trim() || null,
        manifest,
        description,
      };
      if (kind === "image") {
        body.kind = "stdio";
        body.image = image.trim();
      } else if (kind === "command") {
        body.kind = "stdio";
        body.command = command.trim();
        body.args = argsText
          .split("\n")
          .map((a) => a.trim())
          .filter((a) => a.length > 0);
      } else {
        body.kind = "remote_oauth";
        body.url = url.trim();
      }
      await apiFetch(`/api/workspaces/${slug}/mcp-catalog`, {
        method: "PUT",
        body: JSON.stringify(body),
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
    const ok = await confirm({
      title: `Remove ${row.name} from the catalog?`,
      description:
        "Any agent attachments to this MCP will be removed too. Connected user accounts will be disconnected.",
      confirmText: "Remove",
    });
    if (!ok) return;
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
        <CardContent className="py-4 text-sm text-fg-faint">
          Only workspace admins and owners can manage the MCP catalog.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {dialog}
      <McpRegistryPicker
        existingSlugs={items.map((i) => i.name)}
        onPick={(entry) => applySeedEntry(defaultsFromSeed(entry))}
      />
      <Card>
        <CardHeader>
          <CardTitle>MCP servers</CardTitle>
          <CardDescription>
            Registered MCP servers. Agents in this workspace can attach
            to any of these from their edit screen. Plaintext for
            secret-kind env values stays in the MCP container — the
            agent never sees it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <div className="text-sm text-fg-faint">Loading…</div>}
          {!loading && items.length === 0 && (
            <div className="text-sm text-fg-faint">
              No MCP servers registered yet. Add one below.
            </div>
          )}
          {!loading && items.length > 0 && (
            <ul className="divide-y divide-border-soft">
              {items.map((row) => (
                <li key={row.id} className="flex items-start justify-between py-3">
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-fg">
                      {row.name}
                      {row.display_name && (
                        <span className="ml-2 font-sans text-xs text-fg-muted">
                          {row.display_name}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-xs text-fg-faint">
                      {row.kind === "remote_oauth"
                        ? row.url
                        : row.image
                          ? row.image
                          : `${row.command ?? ""} ${row.args.join(" ")}`.trim()}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="secondary" className="text-xs">
                        {row.kind === "remote_oauth"
                          ? "remote oauth"
                          : row.image
                            ? "image"
                            : "command"}
                      </Badge>
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

      <Card id="mcp-add-form">
        <CardHeader>
          <CardTitle>
            {editing ? `Edit ${editing.name}` : "Register MCP server"}
          </CardTitle>
          <CardDescription>
            Choose a shape, paste the manifest the MCP author publishes,
            and save. Names follow the mcpServers convention: lowercase
            letters, digits, hyphens, underscores; start with a letter.
            Picking a server above pre-fills this form — review and Save.
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
              <Label>Shape</Label>
              <div className="flex gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mcp-kind"
                    checked={kind === "image"}
                    onChange={() => setKind("image")}
                  />
                  <span>Container image</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mcp-kind"
                    checked={kind === "command"}
                    onChange={() => setKind("command")}
                  />
                  <span>Command (npx / uvx / etc.)</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mcp-kind"
                    checked={kind === "remote_oauth"}
                    onChange={() => setKind("remote_oauth")}
                  />
                  <span>Remote URL + OAuth</span>
                </label>
              </div>
              {kind === "remote_oauth" && (
                <p className="text-xs text-amber-400">
                  Remote OAuth MCPs run server-side (Mercury, Notion,
                  etc.) and the agent acts AS the user driving the
                  session. They can only be attached to <strong>worker</strong> agents — not orchestrators or scheduled agents.
                </p>
              )}
            </div>

            {kind === "image" ? (
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
                <p className="text-xs text-fg-faint">
                  The runtime spawns this image as a sibling container in
                  the agent's pod.
                </p>
              </div>
            ) : kind === "remote_oauth" ? (
              <div className="space-y-1.5">
                <Label htmlFor="mcp-url">MCP server URL</Label>
                <Input
                  id="mcp-url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.notion.com/mcp"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  disabled={!!editing}
                />
                <p className="text-xs text-fg-faint">
                  On save, the platform discovers OAuth metadata at this URL
                  and registers a client via Dynamic Client Registration.
                  This may take a few seconds. URL cannot be changed after
                  registration — re-create the entry to point at a different
                  server.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    required
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-args">Args (one per line)</Label>
                  <Textarea
                    id="mcp-args"
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    placeholder={"-y\n@author/mercury-mcp"}
                    rows={4}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                  <p className="text-xs text-fg-faint">
                    The runtime spawns the platform's mcp-runner base
                    image (node + python + uv preinstalled) and runs
                    <code className="mx-1">{command || "<command>"} {argsText.split("\n").filter(Boolean).join(" ")}</code>
                    inside it.
                  </p>
                </div>
              </div>
            )}

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
              <p className="text-xs text-fg-faint">
                JSON object with <code>env</code> and <code>tool_scopes</code>.
                See your MCP source for the manifest contents.
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
