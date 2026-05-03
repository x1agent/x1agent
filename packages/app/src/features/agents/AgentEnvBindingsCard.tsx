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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

/**
 * Per-agent Zone-2 env bindings. Workspace admin maps a workspace
 * secret directly to an env-var the agent container will see at
 * runtime. Anything the agent runs reads it in plaintext — this is
 * an explicit operator trust grant.
 *
 * See docs/security/agent-env.md.
 */

interface Binding {
  id: string;
  env_name: string;
  secret_name: string;
}

interface SecretRow {
  id: string;
  name: string;
}

interface Props {
  workspaceSlug: string;
  agentId: string;
  canManage: boolean;
  /** Notifies the parent (badge in header) when bindings transition to/from empty. */
  onCountChange?: (n: number) => void;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function AgentEnvBindingsCard({
  workspaceSlug,
  agentId,
  canManage,
  onCountChange,
}: Props) {
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [envName, setEnvName] = useState("");
  const [secretName, setSecretName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [b, s] = await Promise.all([
        apiFetch<{ bindings: Binding[] }>(
          `/api/workspaces/${workspaceSlug}/agents/${agentId}/env`,
        ),
        apiFetch<{ secrets: SecretRow[] }>(
          `/api/workspaces/${workspaceSlug}/secrets`,
        ),
      ]);
      setBindings(b.bindings);
      setSecrets(s.secrets);
      onCountChange?.(b.bindings.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canManage) void load();
  }, [workspaceSlug, agentId, canManage]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
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
      await apiFetch(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/env/${envName}`,
        {
          method: "PUT",
          body: JSON.stringify({ secret_name: secretName }),
        },
      );
      setEnvName("");
      setSecretName("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(b: Binding) {
    if (!canManage) return;
    if (!confirm(`Remove ${b.env_name}? The agent will lose this credential at next session start.`)) return;
    setError(null);
    try {
      await apiFetch(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/env/${b.env_name}`,
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
          Only workspace admins and owners can manage agent env bindings.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
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
          {loading && <div className="text-sm text-zinc-500">Loading…</div>}
          {!loading && bindings.length === 0 && (
            <div className="text-sm text-zinc-500">
              No env bindings. Add one below if the agent needs a
              workspace secret in its environment.
            </div>
          )}
          {!loading && bindings.length > 0 && (
            <ul className="divide-y divide-zinc-800">
              {bindings.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="font-mono text-sm">
                    <span className="text-zinc-100">{b.env_name}</span>
                    <span className="mx-2 text-zinc-500">←</span>
                    <span className="text-zinc-400">${"{"}{b.secret_name}{"}"}</span>
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
          <form onSubmit={onAdd} className="space-y-3">
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
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Add binding"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
