import { useEffect, useMemo, useState } from "react";
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
import {
  useMcpStore,
  mcpAgentKey,
  type AttachmentEnvValue,
  type CatalogEntry,
} from "../../stores/mcpStore";
import { useWorkspaceSecretsStore } from "../../stores/workspaceSecretsStore";

/**
 * Per-agent MCP attachments. Reads from useMcpStore + the workspace
 * secrets store; never calls apiFetch directly. Local state is for
 * pure UI concerns (in-flight submit, picked entry, env-form values).
 */

interface Props {
  workspaceSlug: string;
  agentId: string;
  agentKind?: "worker" | "orchestrator" | "scheduled";
  canManage: boolean;
}

export function AgentMcpAttachmentsCard({
  workspaceSlug,
  agentId,
  agentKind,
  canManage,
}: Props) {
  const catalog = useMcpStore(
    (s) => s.catalogBySlug[workspaceSlug] ?? [],
  );
  const attachments = useMcpStore(
    (s) => s.attachmentsByAgentKey[mcpAgentKey(workspaceSlug, agentId)] ?? [],
  );
  const userTokens = useMcpStore((s) => s.userTokens);
  const loadCatalog = useMcpStore((s) => s.loadCatalog);
  const loadAttachments = useMcpStore((s) => s.loadAttachments);
  const loadUserTokens = useMcpStore((s) => s.loadUserTokens);
  const attach = useMcpStore((s) => s.attach);
  const detach = useMcpStore((s) => s.detach);
  const disconnectToken = useMcpStore((s) => s.disconnectToken);

  const secrets = useWorkspaceSecretsStore(
    (s) => s.byWorkspace[workspaceSlug] ?? [],
  );
  const loadSecrets = useWorkspaceSecretsStore((s) => s.load);

  const [error, setError] = useState<string | null>(null);
  const [pickedEntryId, setPickedEntryId] = useState("");
  const [envInputs, setEnvInputs] = useState<Record<string, AttachmentEnvValue>>({});
  const [submitting, setSubmitting] = useState(false);

  const pickedEntry = useMemo(
    () => catalog.find((c) => c.id === pickedEntryId) ?? null,
    [catalog, pickedEntryId],
  );

  useEffect(() => {
    if (!canManage) return;
    void loadCatalog(workspaceSlug);
    void loadAttachments(workspaceSlug, agentId);
    void loadUserTokens();
    void loadSecrets(workspaceSlug);
  }, [
    canManage,
    workspaceSlug,
    agentId,
    loadCatalog,
    loadAttachments,
    loadUserTokens,
    loadSecrets,
  ]);

  // Refresh tokens when the user returns from an OAuth provider tab.
  // Only triggers on visibility transitions (tab background → foreground)
  // so an in-page Select close doesn't cause a re-render storm.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && canManage) {
        void loadUserTokens();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [canManage, loadUserTokens]);

  // Reset env-form values when the picked entry changes — but only
  // when the actual id changes, not on every catalog re-fetch.
  useEffect(() => {
    if (!pickedEntry) {
      setEnvInputs({});
      return;
    }
    const init: Record<string, AttachmentEnvValue> = {};
    for (const [name, decl] of Object.entries(pickedEntry.manifest.env)) {
      init[name] =
        decl.kind === "secret"
          ? { kind: "secret", ref: "" }
          : { kind: "value", value: "" };
    }
    setEnvInputs(init);
    // Re-init only when the chosen entry id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedEntryId]);

  function tokenStatusFor(catalogEntryId: string) {
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
    const url =
      `/auth/mcp/start/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(catalogName)}` +
      `?return_to=${encodeURIComponent(window.location.href)}`;
    window.open(url, "_blank", "noopener");
  }

  async function onAttach() {
    if (!canManage || !pickedEntry) return;
    setError(null);
    const cleaned: Record<string, AttachmentEnvValue> = {};
    for (const [k, v] of Object.entries(envInputs)) {
      if (v.kind === "secret" && v.ref.trim() === "") continue;
      if (v.kind === "value" && v.value === "") continue;
      cleaned[k] = v;
    }
    setSubmitting(true);
    try {
      await attach(workspaceSlug, agentId, {
        catalog_entry_id: pickedEntry.id,
        env_json: cleaned,
      });
      setPickedEntryId("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDetach(att: { id: string; catalog_entry_id: string }) {
    if (!canManage) return;
    const entry = catalog.find((c) => c.id === att.catalog_entry_id);
    const label = entry?.name ?? "this MCP";
    if (!confirm(`Detach ${label} from this agent?`)) return;
    setError(null);
    try {
      await detach(workspaceSlug, agentId, att.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onDisconnect(catalogEntryId: string) {
    if (!confirm("Disconnect this account? The agent will be unable to use this MCP until you reconnect.")) return;
    try {
      await disconnectToken(catalogEntryId);
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
  const pickableCatalog = catalog
    .filter((c) => !attachments.some((a) => a.catalog_entry_id === c.id))
    .filter((c) => {
      // Remote OAuth requires an interactive user — only attachable
      // to worker agents.
      if (c.kind !== "remote_oauth") return true;
      return agentKind === "worker" || agentKind === undefined;
    });

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
          {attachments.length === 0 && (
            <div className="text-sm text-zinc-500">
              No MCP servers attached. Add one below.
            </div>
          )}
          {attachments.length > 0 && (
            <ul className="divide-y divide-zinc-800">
              {attachments.map((att) => {
                const entry = entryById(att.catalog_entry_id);
                const isOAuth = entry?.kind === "remote_oauth";
                const tokenStatus = isOAuth
                  ? tokenStatusFor(att.catalog_entry_id)
                  : { connected: true, expired: false };
                return (
                  <li key={att.id} className="flex items-start justify-between py-3">
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
                              onClick={() => onDisconnect(att.catalog_entry_id)}
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
          ) : pickableCatalog.length === 0 ? (
            <div className="text-sm text-zinc-500">
              All registered MCP servers are already attached, or none
              are compatible with this agent kind.
            </div>
          ) : (
            // Plain div, not <form>: this card is rendered inside the
            // agent edit page's outer <form>. Nested forms would
            // un-nest and the Attach button would trigger the agent
            // save instead of the per-attachment PUT.
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-pick">MCP server</Label>
                <Select value={pickedEntryId} onValueChange={setPickedEntryId}>
                  <SelectTrigger id="mcp-pick">
                    <SelectValue placeholder="Pick a registered MCP" />
                  </SelectTrigger>
                  <SelectContent>
                    {pickableCatalog.map((c) => (
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
  decl: CatalogEntry["manifest"]["env"][string];
  value: AttachmentEnvValue | undefined;
  secrets: Array<{ id: string; name: string }>;
  onChange: (v: AttachmentEnvValue) => void;
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
