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
import { useAgentEnvBindingsStore } from "../../stores/agentEnvBindingsStore";
import { useWorkspaceSecretsStore } from "../../stores/workspaceSecretsStore";
import { useConfirm } from "../../components/use-confirm";

/**
 * Per-agent Zone-2 env bindings. Reads from useAgentEnvBindingsStore
 * + the workspace_secrets store. Local state is for UI concerns
 * (form values, in-flight submit). Never calls apiFetch directly.
 */

interface Props {
  workspaceSlug: string;
  agentId: string;
  canManage: boolean;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function AgentEnvBindingsCard({
  workspaceSlug,
  agentId,
  canManage,
}: Props) {
  // Whole-record selectors + outside lookup so the selector returns
  // a stable reference; `?? []` in the selector creates a new array
  // each render and infinite-loops React.
  const byAgentKey = useAgentEnvBindingsStore((s) => s.byAgentKey);
  const loadBindings = useAgentEnvBindingsStore((s) => s.load);
  const setBinding = useAgentEnvBindingsStore((s) => s.setBinding);
  const removeBinding = useAgentEnvBindingsStore((s) => s.remove);

  const secretsByWorkspace = useWorkspaceSecretsStore((s) => s.byWorkspace);
  const loadSecrets = useWorkspaceSecretsStore((s) => s.load);
  const bindings = byAgentKey[`${workspaceSlug}:${agentId}`] ?? [];
  const secrets = secretsByWorkspace[workspaceSlug] ?? [];

  const [error, setError] = useState<string | null>(null);
  const [envName, setEnvName] = useState("");
  const [secretName, setSecretName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // X1A-86 — bindings list grows unbounded for an agent with many
  // operator-injected credentials. Paginate to 5 by default (10 on
  // toggle), with a search filter over env_name + secret_name.
  const [search, setSearch] = useState("");
  const [pageSize, setPageSize] = useState<5 | 10>(5);
  const [page, setPage] = useState(0);
  const { confirm, dialog } = useConfirm();

  const filteredBindings = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bindings;
    return bindings.filter(
      (b) =>
        b.env_name.toLowerCase().includes(q) ||
        b.secret_name.toLowerCase().includes(q),
    );
  }, [bindings, search]);

  const pageCount = Math.max(1, Math.ceil(filteredBindings.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pagedBindings = filteredBindings.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  useEffect(() => {
    setPage(0);
  }, [search, pageSize, bindings.length]);

  useEffect(() => {
    if (!canManage) return;
    void loadBindings(workspaceSlug, agentId);
    void loadSecrets(workspaceSlug);
  }, [canManage, workspaceSlug, agentId, loadBindings, loadSecrets]);

  async function onAdd() {
    if (!canManage) return;
    setError(null);
    if (!ENV_NAME_RE.test(envName)) {
      setError(
        "Env name must be uppercase letters, digits, underscores; start with a letter or underscore.",
      );
      return;
    }
    if (!secretName) {
      setError("Pick a workspace secret.");
      return;
    }
    setSubmitting(true);
    try {
      await setBinding(workspaceSlug, agentId, { envName, secretName });
      setEnvName("");
      setSecretName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(b: { id: string; env_name: string }) {
    if (!canManage) return;
    const ok = await confirm({
      title: `Remove ${b.env_name}?`,
      description:
        "The agent will lose this credential at next session start.",
      confirmText: "Remove",
    });
    if (!ok) return;
    setError(null);
    try {
      await removeBinding(workspaceSlug, agentId, b.env_name);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-fg-faint">
          Only workspace admins and owners can manage agent env bindings.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {dialog}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Environment variables
            {bindings.length > 0 && (
              <Badge variant="warning" className="text-xs">
                operator-injected credentials
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Workspace secrets exposed directly to the agent container's
            <code className="mx-1">process.env</code>. The agent (and
            anything it runs — bash, the LLM's tool calls) sees these
            values in plaintext. Use only when the agent itself needs
            to be the authenticated principal (its own API key, its
            own GitHub PAT). For credentials consumed via an MCP tool,
            use MCP attachments above instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {bindings.length === 0 && (
            <div className="text-sm text-fg-faint">
              No env bindings. Add one below if the agent needs a
              workspace secret in its environment.
            </div>
          )}
          {bindings.length > 0 && (
            <>
              <div className="mb-2 flex items-center gap-2">
                <Input
                  className="h-8 flex-1 text-sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${bindings.length} binding${bindings.length === 1 ? "" : "s"}…`}
                  aria-label="Search env bindings"
                />
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => setPageSize(Number(v) as 5 | 10)}
                >
                  <SelectTrigger
                    className="h-8 w-24 text-xs"
                    aria-label="Bindings per page"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 / page</SelectItem>
                    <SelectItem value="10">10 / page</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {filteredBindings.length === 0 && (
                <div className="text-sm text-fg-faint">
                  No bindings match "{search.trim()}".
                </div>
              )}
              {pagedBindings.length > 0 && (
                <ul className="divide-y divide-border-soft">
                  {pagedBindings.map((b) => (
                    <li
                      key={b.id}
                      className="flex items-center justify-between py-3"
                    >
                      <div className="font-mono text-sm">
                        <span className="text-fg">{b.env_name}</span>
                        <span className="mx-2 text-fg-faint">←</span>
                        <span className="text-fg-muted">
                          ${"{"}{b.secret_name}{"}"}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRemove(b)}
                      >
                        Unlink
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {pageCount > 1 && (
                <div className="mt-2 flex items-center justify-between text-xs text-fg-faint">
                  <div>
                    {filteredBindings.length} match
                    {filteredBindings.length === 1 ? "" : "es"}
                    {" · "}
                    page {safePage + 1} of {pageCount}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={safePage === 0}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                    >
                      Prev
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={safePage >= pageCount - 1}
                      onClick={() =>
                        setPage((p) => Math.min(pageCount - 1, p + 1))
                      }
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add env binding</CardTitle>
          <CardDescription>
            The env-var name is what the agent's process sees. The
            secret value is resolved at session start from the
            workspace's secret bundle — plaintext never lands in the
            pod spec.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Plain div, not <form>: this card is rendered inside the
              agent edit page's outer <form>. */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="env-name">Env var name</Label>
                <Input
                  id="env-name"
                  required
                  value={envName}
                  onChange={(e) => setEnvName(e.target.value.toUpperCase())}
                  placeholder="ANTHROPIC_API_KEY"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="env-secret">Workspace secret</Label>
                <Select value={secretName} onValueChange={setSecretName}>
                  <SelectTrigger id="env-secret">
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
                          ${"{"}
                          {s.name}
                          {"}"}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {error && <div className="text-sm text-red-400">{error}</div>}
            <div className="flex items-center gap-2 pt-2">
              <Button type="button" disabled={submitting} onClick={onAdd}>
                {submitting ? "Saving…" : "Add binding"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
