import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { AppShell } from "../../shell/AppShell";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAuthStore } from "../../stores/authStore";
import { useAgentsStore } from "../../stores/agentsStore";
import { useCollectionsStore } from "../../stores/collectionsStore";
import { useGitHubStore } from "../../stores/githubStore";
import { useGrantsStore } from "../../stores/grantsStore";
import { RecentRunsSection } from "../sessions/RecentRunsSection";
import { SpawnSessionCard } from "../sessions/SpawnSessionCard";

interface Props {
  workspaceSlug: string;
  agentSlug: string;
}

/**
 * Detail page for a single agent. Kept intentionally minimal: identity
 * header, a compact configuration summary that links into the edit
 * page's tabs, and the Run card. Everything editable lives behind the
 * Edit button so this page reads as "what is this agent and what has
 * it been doing" rather than "every config surface at once".
 */
export function AgentDetailRoot({ workspaceSlug, agentSlug }: Props) {
  const { status, memberships, fetchMe } = useAuthStore();
  const { bySlug, load } = useAgentsStore();

  const loadRepos = useGitHubStore((s) => s.loadAgentRepos);
  const agentRepos = useGitHubStore((s) => s.agentRepos);

  const loadCollections = useCollectionsStore((s) => s.loadAttachments);
  const attachmentsByKey = useCollectionsStore((s) => s.attachmentsByAgentKey);

  const loadSpawnGrants = useGrantsStore((s) => s.loadSpawnGrants);
  const spawnByAgent = useGrantsStore((s) => s.spawnByAgent);

  // MCP attachments + Zone-2 env bindings — small lists, fetched
  // directly here. Counts only; the full editor lives on the Edit
  // page's "MCP & env" tab.
  const [mcpAttachmentCount, setMcpAttachmentCount] = useState<number | null>(
    null,
  );
  const [envBindingCount, setEnvBindingCount] = useState<number | null>(null);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === "anonymous" && typeof window !== "undefined") {
      window.location.href = "/";
    }
  }, [status]);

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  const ws = memberships.find((m) => m.slug === workspaceSlug);
  const canManage = ws?.role === "admin" || ws?.role === "owner";
  const agent = (bySlug[workspaceSlug] ?? []).find((a) => a.slug === agentSlug);

  useEffect(() => {
    if (!agent) return;
    loadRepos(workspaceSlug, agent.id);
    loadCollections(workspaceSlug, agent.id);
    loadSpawnGrants(workspaceSlug, agent.id);

    // Direct fetches for the MCP + env summary rows. Failures are
    // soft — the row falls back to "—" rather than blowing up the page.
    const aid = agent.id;
    apiFetch<{ attachments: Array<{ id: string }> }>(
      `/api/workspaces/${workspaceSlug}/agents/${aid}/mcp-attachments`,
    )
      .then((r) => setMcpAttachmentCount(r.attachments.length))
      .catch(() => setMcpAttachmentCount(null));
    apiFetch<{ bindings: Array<{ id: string }> }>(
      `/api/workspaces/${workspaceSlug}/agents/${aid}/env`,
    )
      .then((r) => setEnvBindingCount(r.bindings.length))
      .catch(() => setEnvBindingCount(null));
  }, [
    agent,
    workspaceSlug,
    loadRepos,
    loadCollections,
    loadSpawnGrants,
  ]);

  const breadcrumbs = [
    { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
    { label: "Agents", href: `/workspaces/${workspaceSlug}` },
    { label: agent?.name ?? agentSlug },
  ];

  if (!agent) {
    return (
      <AppShell breadcrumbs={breadcrumbs}>
        <div className="p-6 text-sm text-zinc-500">
          {bySlug[workspaceSlug] ? "Agent not found." : "Loading…"}
        </div>
      </AppShell>
    );
  }

  const repos = agentRepos[agent.id]?.repos ?? [];
  const attachmentKey = `${workspaceSlug}:${agent.id}`;
  const collections = attachmentsByKey[attachmentKey] ?? [];
  const spawnGrants = spawnByAgent[attachmentKey] ?? [];

  const editHref = `/workspaces/${workspaceSlug}/agents/${agent.slug}/edit`;

  return (
    <AppShell
      breadcrumbs={breadcrumbs}
      actions={
        canManage ? (
          <Button variant="outline" size="sm" asChild>
            <a href={editHref}>Edit</a>
          </Button>
        ) : undefined
      }
    >
      <div className="max-w-3xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">{agent.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
            <code className="font-mono">{agent.slug}</code>
            <span>·</span>
            <span>{agent.runtime_type}</span>
            <span>·</span>
            <Badge variant={agent.is_active ? "success" : "secondary"}>
              {agent.is_active ? "active" : "paused"}
            </Badge>
          </div>
        </div>

        <SpawnSessionCard workspaceSlug={workspaceSlug} agentId={agent.id} />

        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>
              Click any row to jump into Edit with that tab open.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <SummaryRow
              href={`${editHref}?tab=general`}
              disabled={!canManage}
              label="Schedule"
              value={agent.schedule ?? "Manual only"}
              muted={!agent.schedule}
            />
            <SummaryRow
              href={`${editHref}?tab=prompts`}
              disabled={!canManage}
              label="Prompts"
              value={
                agent.system_prompt.trim()
                  ? `${agent.system_prompt.trim().length} chars${
                      agent.schedule && agent.heartbeat_md.trim()
                        ? " + heartbeat"
                        : ""
                    }`
                  : "Not set"
              }
              muted={!agent.system_prompt.trim()}
            />
            <SummaryRow
              href={`${editHref}?tab=repos`}
              disabled={!canManage}
              label="Repositories"
              value={
                repos.length === 0
                  ? "None attached"
                  : `${repos.length} attached`
              }
              muted={repos.length === 0}
            />
            <SummaryRow
              href={`${editHref}?tab=collections`}
              disabled={!canManage}
              label="Collections"
              value={
                collections.length === 0
                  ? "None attached"
                  : `${collections.length} attached`
              }
              muted={collections.length === 0}
            />
            <SummaryRow
              href={`${editHref}?tab=mcp`}
              disabled={!canManage}
              label="MCP servers"
              value={
                mcpAttachmentCount === null
                  ? "—"
                  : mcpAttachmentCount === 0
                    ? "None attached"
                    : `${mcpAttachmentCount} attached`
              }
              muted={mcpAttachmentCount === 0 || mcpAttachmentCount === null}
            />
            <SummaryRow
              href={`${editHref}?tab=mcp`}
              disabled={!canManage}
              label="Environment variables"
              value={
                envBindingCount === null
                  ? "—"
                  : envBindingCount === 0
                    ? "None set"
                    : `${envBindingCount} set${envBindingCount > 0 ? " (operator-injected)" : ""}`
              }
              muted={envBindingCount === 0 || envBindingCount === null}
            />
            <SummaryRow
              href={`${editHref}?tab=permissions`}
              disabled={!canManage}
              label="Can spawn"
              value={
                spawnGrants.length === 0
                  ? "No grants"
                  : `${spawnGrants.length} agent${spawnGrants.length === 1 ? "" : "s"}`
              }
              muted={spawnGrants.length === 0}
              last
            />
          </CardContent>
        </Card>

        <RecentRunsSection workspaceSlug={workspaceSlug} agentId={agent.id} />
      </div>
    </AppShell>
  );
}

function SummaryRow({
  href,
  disabled,
  label,
  value,
  muted,
  last,
}: {
  href: string;
  disabled?: boolean;
  label: string;
  value: string;
  muted?: boolean;
  last?: boolean;
}) {
  const content = (
    <>
      <span className="text-sm text-zinc-400">{label}</span>
      <span
        className={`ml-auto truncate text-sm ${
          muted ? "text-zinc-600" : "text-zinc-200"
        }`}
      >
        {value}
      </span>
      {!disabled && (
        <ChevronRight className="size-4 shrink-0 text-zinc-700 group-hover:text-zinc-400" />
      )}
    </>
  );

  const base = `group flex items-center gap-3 px-4 py-3 ${
    last ? "" : "border-b border-zinc-900"
  }`;
  if (disabled) {
    return <div className={base}>{content}</div>;
  }
  return (
    <a href={href} className={`${base} hover:bg-zinc-900/40`}>
      {content}
    </a>
  );
}
