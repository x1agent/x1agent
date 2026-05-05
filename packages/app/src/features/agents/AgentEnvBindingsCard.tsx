import { useEffect, useState } from "react";
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
  const { confirm, dialog } = useConfirm();

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
            <ul className="divide-y divide-border-soft">
              {bindings.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="font-mono text-sm">
                    <span className="text-fg">{b.env_name}</span>
                    <span className="mx-2 text-fg-faint">←</span>
                    <span className="text-fg-muted">${"{"}{b.secret_name}{"}"}</span>
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
