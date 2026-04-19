import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useGitHubStore } from "../../stores/githubStore";

interface Props {
  workspaceSlug: string;
  agentId: string | null;
}

/**
 * Rendered on the AgentEditRoot when an agent exists (edit mode).
 * Lets an admin attach/detach repos. Enforces "one installation per
 * agent" at the UI layer by locking the installation selector to the
 * one already linked once any repo has been attached.
 */
export function AgentReposSection({ workspaceSlug, agentId }: Props) {
  const {
    config,
    installations,
    loadConfig,
    loadInstallations,
    loadReposForInstallation,
    reposById,
    reposLoadingId,
    agentRepos,
    loadAgentRepos,
    attachRepo,
    updateRepo,
    detachRepo,
  } = useGitHubStore();

  const [selectedInstall, setSelectedInstall] = useState<number | null>(null);
  const [branchDraft, setBranchDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (config?.configured) loadInstallations();
  }, [config?.configured, loadInstallations]);

  useEffect(() => {
    if (agentId) loadAgentRepos(workspaceSlug, agentId);
  }, [agentId, workspaceSlug, loadAgentRepos]);

  const agentState = agentId ? agentRepos[agentId] : undefined;
  const pinnedInstall = agentState?.installation_id ?? null;

  // Once the agent has any repos, the installation is pinned; the
  // selector collapses to that installation only.
  const activeInstall =
    pinnedInstall ??
    selectedInstall ??
    (installations[0]?.installation_id ?? null);

  useEffect(() => {
    if (activeInstall && !reposById[activeInstall])
      loadReposForInstallation(activeInstall);
  }, [activeInstall, reposById, loadReposForInstallation]);

  const availableRepos = useMemo(() => {
    if (!activeInstall) return [];
    const all = reposById[activeInstall] ?? [];
    const attached = new Set(
      (agentState?.repos ?? []).map((r) => r.repo_full_name),
    );
    return all.filter((r) => !attached.has(r.full_name));
  }, [activeInstall, reposById, agentState?.repos]);

  if (!config?.configured) return null;
  if (!agentId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Linked repositories</CardTitle>
          <CardDescription>
            Create the agent first. You can attach repos once it exists.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const onAttach = async (repoFullName: string, defaultBranch: string) => {
    if (!activeInstall) return;
    setError(null);
    setBusy(true);
    try {
      const branch = (branchDraft[repoFullName] || defaultBranch).trim();
      await attachRepo(workspaceSlug, agentId, activeInstall, repoFullName, {
        branch: branch || defaultBranch,
      });
      setBranchDraft((d) => {
        const next = { ...d };
        delete next[repoFullName];
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onUpdateBranch = async (repoFullName: string, branch: string) => {
    try {
      await updateRepo(workspaceSlug, agentId, repoFullName, {
        branch: branch.trim() || "main",
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Linked repositories</CardTitle>
        <CardDescription>
          Repos cloned into the agent's workspace at session start. All repos
          on one agent must share a single GitHub installation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {installations.length === 0 && (
          <div className="text-sm text-zinc-500">
            No installations. Visit{" "}
            <a className="underline" href="/account">
              /account
            </a>{" "}
            to install the GitHub App first.
          </div>
        )}

        {installations.length > 0 && (
          <div>
            <Label className="mb-1 block">Installation</Label>
            {pinnedInstall ? (
              <div className="text-sm text-zinc-300">
                {installations.find(
                  (i) => i.installation_id === pinnedInstall,
                )?.account_login ?? `#${pinnedInstall}`}
                <span className="ml-2 text-xs text-zinc-500">
                  (locked while repos are attached)
                </span>
              </div>
            ) : (
              <Select
                value={activeInstall?.toString() ?? ""}
                onValueChange={(v) => setSelectedInstall(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick an installation" />
                </SelectTrigger>
                <SelectContent>
                  {installations.map((inst) => (
                    <SelectItem
                      key={inst.installation_id}
                      value={inst.installation_id.toString()}
                    >
                      {inst.account_login} (#{inst.installation_id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        {(agentState?.repos.length ?? 0) > 0 && (
          <div>
            <Label className="mb-1 block">Attached</Label>
            <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
              {agentState!.repos.map((repo) => (
                <li
                  key={repo.repo_full_name}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-zinc-100">
                      {repo.repo_full_name}
                    </div>
                    <div className="text-xs text-zinc-500">
                      /workspace/{repo.mount_path}
                    </div>
                  </div>
                  <Input
                    className="h-7 w-44 text-xs"
                    defaultValue={repo.branch}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next && next !== repo.branch) {
                        onUpdateBranch(repo.repo_full_name, next);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="branch"
                    aria-label={`Branch for ${repo.repo_full_name}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      detachRepo(workspaceSlug, agentId, repo.repo_full_name)
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-zinc-500">
              At session start the sidecar clones each repo to
              <code className="mx-1 rounded bg-zinc-800 px-1 py-0.5">
                /workspace/&lt;mount_path&gt;
              </code>
              and checks out the branch (created locally if it doesn't exist
              remotely).
            </p>
          </div>
        )}

        {activeInstall && (
          <div>
            <Label className="mb-1 block">Available</Label>
            {reposLoadingId === activeInstall && (
              <div className="text-sm text-zinc-400">Loading repos…</div>
            )}
            {availableRepos.length === 0 && reposLoadingId !== activeInstall && (
              <div className="text-sm text-zinc-500">
                No more repos available from this installation.
              </div>
            )}
            {availableRepos.length > 0 && (
              <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
                {availableRepos.map((repo) => (
                  <li
                    key={repo.full_name}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-zinc-100">
                        {repo.full_name}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {repo.private ? "private · " : ""}
                        default: {repo.default_branch}
                      </div>
                    </div>
                    <Input
                      className="h-7 w-44 text-xs"
                      value={branchDraft[repo.full_name] ?? ""}
                      onChange={(e) =>
                        setBranchDraft((d) => ({
                          ...d,
                          [repo.full_name]: e.target.value,
                        }))
                      }
                      placeholder={repo.default_branch}
                      aria-label={`Branch for ${repo.full_name}`}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onAttach(repo.full_name, repo.default_branch)}
                    >
                      Attach
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <div className="text-sm text-red-400">{error}</div>}
      </CardContent>
    </Card>
  );
}
