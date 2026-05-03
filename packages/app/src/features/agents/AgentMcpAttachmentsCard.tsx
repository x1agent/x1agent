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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

/**
 * Per-agent MCP attachments. Pick a workspace catalog entry, fill
 * in the env values it needs (secret-kind: pick from workspace
 * secrets dropdown; value-kind: type literal), save.
 */

interface CatalogEntry {
  id: string;
  name: string;
  display_name: string | null;
  kind: "stdio" | "remote_oauth";
  manifest: {
    env: Record<
      string,
      { kind: "secret" | "value"; label?: string; required?: boolean; description?: string }
    >;
    tool_scopes: Record<string, string[]>;
  };
}

type EnvValue =
  | { kind: "secret"; ref: string }
  | { kind: "value"; value: string };

interface Attachment {
  id: string;
  catalog_entry_id: string;
  env_json: Record<string, EnvValue>;
  tool_scopes_granted: string[];
}

interface SecretRow {
  id: string;
  name: string;
}

interface UserMcpToken {
  catalog_entry_id: string;
  access_token_expires_at: string | null;
  has_refresh_token: boolean;
  updated_at: string;
}

interface Props {
  workspaceSlug: string;
  agentId: string;
  /** Agent kind — drives whether remote_oauth catalog entries are pickable. */
  agentKind?: "worker" | "orchestrator" | "scheduled";
  canManage: boolean;
}

export function AgentMcpAttachmentsCard({
  workspaceSlug,
  agentId,
  agentKind,
  canManage,
}: Props) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [userTokens, setUserTokens] = useState<UserMcpToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pickedEntryId, setPickedEntryId] = useState<string>("");
  const [envInputs, setEnvInputs] = useState<Record<string, EnvValue>>({});
  const [submitting, setSubmitting] = useState(false);

  const pickedEntry = useMemo(
    () => catalog.find((c) => c.id === pickedEntryId) ?? null,
    [catalog, pickedEntryId],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [c, s, a, t] = await Promise.all([
        apiFetch<{ entries: CatalogEntry[] }>(
          `/api/workspaces/${workspaceSlug}/mcp-catalog`,
        ),
        apiFetch<{ secrets: SecretRow[] }>(
          `/api/workspaces/${workspaceSlug}/secrets`,
        ),
        apiFetch<{ attachments: Attachment[] }>(
          `/api/workspaces/${workspaceSlug}/agents/${agentId}/mcp-attachments`,
        ),
        apiFetch<{ tokens: UserMcpToken[] }>(`/api/users/me/mcp-tokens`).catch(
          () => ({ tokens: [] }),
        ),
      ]);
      setCatalog(c.entries);
      setSecrets(s.secrets);
      setAttachments(a.attachments);
      setUserTokens(t.tokens);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canManage) void load();
  }, [workspaceSlug, agentId, canManage]);

  // When the user comes back to this tab from the OAuth provider,
  // refresh the token list so the Connect button updates to "Connected".
  useEffect(() => {
    function onFocus() {
      if (canManage) void load();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [canManage]);

  function tokenStatusFor(catalogEntryId: string): {
    connected: boolean;
    expired: boolean;
  } {
    const t = userTokens.find((x) => x.catalog_entry_id === catalogEntryId);
    if (!t) return { connected: false, expired: false };
    const expiresAt = t.access_token_expires_at
      ? Date.parse(t.access_token_expires_at)
      : null;
    const expired =
      expiresAt !== null && expiresAt < Date.now() && !t.has_refresh_token;
    return { connected: !expired, expired };
  }

  function startOAuth(catalogName: string) {
    const url = `/auth/mcp/start/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(catalogName)}?return_to=${encodeURIComponent(window.location.href)}`;
    // Open in a new tab so the user can come back here easily.
    window.open(url, "_blank", "noopener");
  }

  async function disconnectOAuth(catalogEntryId: string) {
    if (!confirm("Disconnect this account? The agent will be unable to use this MCP until you reconnect.")) return;
    try {
      await apiFetch(`/api/users/me/mcp-tokens/${catalogEntryId}`, {
        method: "DELETE",
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Reset env inputs when the picked entry changes — the field set
  // is derived from the entry's manifest.
  useEffect(() => {
    if (!pickedEntry) {
      setEnvInputs({});
      return;
    }
    const init: Record<string, EnvValue> = {};
    for (const [name, decl] of Object.entries(pickedEntry.manifest.env)) {
      init[name] =
        decl.kind === "secret"
          ? { kind: "secret", ref: "" }
          : { kind: "value", value: "" };
    }
    setEnvInputs(init);
  }, [pickedEntry]);

  async function onAttach(e?: React.FormEvent | React.MouseEvent) {
    if (e && "preventDefault" in e) e.preventDefault();
    if (!canManage || !pickedEntry) return;
    setError(null);
    // Strip empty optional fields so the server's "missing required"
    // signal is the only signal the user sees.
    const cleaned: Record<string, EnvValue> = {};
    for (const [k, v] of Object.entries(envInputs)) {
      if (v.kind === "secret" && v.ref.trim() === "") continue;
      if (v.kind === "value" && v.value === "") continue;
      cleaned[k] = v;
    }
    setSubmitting(true);
    try {
      await apiFetch(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/mcp-attachments`,
        {
          method: "PUT",
          body: JSON.stringify({
            catalog_entry_id: pickedEntry.id,
            env_json: cleaned,
          }),
        },
      );
      setPickedEntryId("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDetach(att: Attachment) {
    if (!canManage) return;
    const entry = catalog.find((c) => c.id === att.catalog_entry_id);
    const label = entry?.name ?? "this MCP";
    if (!confirm(`Detach ${label} from this agent?`)) return;
    setError(null);
    try {
      await apiFetch(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/mcp-attachments/${att.id}`,
        { method: "DELETE" },
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-zinc-500">
          Only workspace admins and owners can manage MCP attachments.
        </CardContent>
      </Card>
    );
  }

  const entryById = (id: string) => catalog.find((c) => c.id === id);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>MCP attachments</CardTitle>
          <CardDescription>
            MCP servers this agent will have access to at session start.
            Secret-kind values stay in the MCP container; the agent
            sees only the MCP's tool output.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <div className="text-sm text-zinc-500">Loading…</div>}
          {!loading && attachments.length === 0 && (
            <div className="text-sm text-zinc-500">
              No MCP servers attached. Add one below.
            </div>
          )}
          {!loading && attachments.length > 0 && (
            <ul className="divide-y divide-zinc-800">
              {attachments.map((att) => {
                const entry = entryById(att.catalog_entry_id);
                const isOAuth = entry?.kind === "remote_oauth";
                const tokenStatus = isOAuth
                  ? tokenStatusFor(att.catalog_entry_id)
                  : { connected: true, expired: false };
                return (
                  <li
                    key={att.id}
                    className="flex items-start justify-between py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-mono text-sm text-zinc-100">
                        {entry?.name ?? att.catalog_entry_id}
                        {entry?.display_name && (
                          <span className="ml-1 font-sans text-xs text-zinc-400">
                            {entry.display_name}
                          </span>
                        )}
                        {isOAuth && tokenStatus.connected && (
                          <Badge variant="success" className="text-xs">
                            connected
                          </Badge>
                        )}
                        {isOAuth && !tokenStatus.connected && (
                          <Badge variant="warning" className="text-xs">
                            not connected
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {Object.entries(att.env_json).map(([k, v]) => (
                          <Badge
                            key={k}
                            variant="outline"
                            className="text-xs font-mono"
                          >
                            {k}={v.kind === "secret" ? `\${${v.ref}}` : "•••"}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isOAuth && entry && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => startOAuth(entry.name)}
                          >
                            {tokenStatus.connected ? "Reconnect" : "Connect"}
                          </Button>
                          {tokenStatus.connected && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => disconnectOAuth(att.catalog_entry_id)}
                            >
                              Disconnect
                            </Button>
                          )}
                        </>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onDetach(att)}
                      >
                        Detach
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attach MCP server</CardTitle>
          <CardDescription>
            Pick from the workspace catalog and fill in the env values
            its manifest declares.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {catalog.length === 0 ? (
            <div className="text-sm text-zinc-500">
              No MCP servers registered in this workspace.{" "}
              <a
                className="underline"
                href={`/workspaces/${workspaceSlug}/settings?tab=mcp`}
              >
                Register one
              </a>{" "}
              first.
            </div>
          ) : (
            // Not a <form> on purpose: this card lives inside the
            // agent edit page's outer <form>. Nested forms would
            // un-nest and the Attach button would trigger the agent
            // save instead of this PUT. Plain div + onClick handler.
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-pick">MCP server</Label>
                <Select value={pickedEntryId} onValueChange={setPickedEntryId}>
                  <SelectTrigger id="mcp-pick">
                    <SelectValue placeholder="Pick a registered MCP" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog
                      .filter(
                        (c) => !attachments.some((a) => a.catalog_entry_id === c.id),
                      )
                      .filter((c) => {
                        // Remote OAuth MCPs require an interactive
                        // user — only attachable to worker agents.
                        if (c.kind !== "remote_oauth") return true;
                        return agentKind === "worker" || agentKind === undefined;
                      })
                      .map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.display_name ?? c.name}{" "}
                          <span className="text-zinc-500">({c.name})</span>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              {pickedEntry && (
                <div className="space-y-3 rounded border border-zinc-800 p-3">
                  {Object.entries(pickedEntry.manifest.env).map(
                    ([envName, decl]) => (
                      <EnvFieldRow
                        key={envName}
                        envName={envName}
                        decl={decl}
                        value={envInputs[envName]}
                        secrets={secrets}
                        onChange={(v) =>
                          setEnvInputs((prev) => ({ ...prev, [envName]: v }))
                        }
                      />
                    ),
                  )}
                  {Object.keys(pickedEntry.manifest.env).length === 0 && (
                    <div className="text-xs text-zinc-500">
                      This MCP requires no env configuration.
                    </div>
                  )}
                </div>
              )}

              {error && <div className="text-sm text-red-400">{error}</div>}
              <div className="flex items-center gap-2 pt-2">
                <Button
                  type="button"
                  disabled={submitting || !pickedEntry}
                  onClick={onAttach}
                >
                  {submitting ? "Attaching…" : "Attach"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface EnvFieldRowProps {
  envName: string;
  decl: {
    kind: "secret" | "value";
    label?: string;
    required?: boolean;
    description?: string;
  };
  value: EnvValue | undefined;
  secrets: SecretRow[];
  onChange: (v: EnvValue) => void;
}

function EnvFieldRow({
  envName,
  decl,
  value,
  secrets,
  onChange,
}: EnvFieldRowProps) {
  const required = decl.required !== false;
  const label = decl.label ?? envName;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`env-${envName}`} className="font-mono text-xs">
        {envName}
        {required && <span className="ml-1 text-red-400">*</span>}
        <span className="ml-2 font-sans text-zinc-500">{label}</span>
      </Label>
      {decl.kind === "secret" ? (
        <Select
          value={value?.kind === "secret" ? value.ref : ""}
          onValueChange={(ref) => onChange({ kind: "secret", ref })}
        >
          <SelectTrigger id={`env-${envName}`}>
            <SelectValue placeholder="Pick a workspace secret (${NAME})" />
          </SelectTrigger>
          <SelectContent>
            {secrets.length === 0 ? (
              <SelectItem value="__none" disabled>
                No workspace secrets yet
              </SelectItem>
            ) : (
              secrets.map((s) => (
                <SelectItem key={s.id} value={s.name}>
                  ${"{"}
                  {s.name}
                  {"}"}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={`env-${envName}`}
          value={value?.kind === "value" ? value.value : ""}
          onChange={(e) => onChange({ kind: "value", value: e.target.value })}
          placeholder={decl.description ?? "literal value"}
          autoComplete="off"
        />
      )}
      {decl.description && (
        <p className="text-xs text-zinc-500">{decl.description}</p>
      )}
    </div>
  );
}
