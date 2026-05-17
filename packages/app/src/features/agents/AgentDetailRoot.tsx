import { useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { AgentRuntimeBadge } from "./AgentRuntimeBadge";
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
import { useHasCollections } from "../../stores/capabilitiesStore";
import { useGitHubStore } from "../../stores/githubStore";
import { useGrantsStore } from "../../stores/grantsStore";
import { useMcpStore, mcpAgentKey } from "../../stores/mcpStore";
import { useAgentEnvBindingsStore } from "../../stores/agentEnvBindingsStore";
import { useSessionsStore } from "../../stores/sessionsStore";
import { AgentCostCard } from "./AgentCostCard";
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
  const hasCollections = useHasCollections();

  const loadSpawnGrants = useGrantsStore((s) => s.loadSpawnGrants);
  const spawnByAgent = useGrantsStore((s) => s.spawnByAgent);

  const loadMcpAttachments = useMcpStore((s) => s.loadAttachments);
  const loadEnvBindings = useAgentEnvBindingsStore((s) => s.load);
  const mcpAttachmentsByKey = useMcpStore((s) => s.attachmentsByAgentKey);
  const envBindingsByKey = useAgentEnvBindingsStore((s) => s.byAgentKey);

  const loadSessions = useSessionsStore((s) => s.load);
  const sessionsByAgent = useSessionsStore((s) => s.byAgent);

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
    if (hasCollections) loadCollections(workspaceSlug, agent.id);
    loadSpawnGrants(workspaceSlug, agent.id);
    // MCP attachments + env bindings are admin/owner-gated on the api
    // (requireAgent in composition). Skip the fetch for plain members
    // so they don't generate 403s on every page load.
    if (canManage) {
      void loadMcpAttachments(workspaceSlug, agent.id);
      void loadEnvBindings(workspaceSlug, agent.id);
    }
    // Sessions are also fetched by RecentRunsSection further down the
    // page; we mirror the load here so the runtime badge has its own
    // explicit dependency rather than depending on render order.
    void loadSessions(workspaceSlug, agent.id);
  }, [
    agent,
    workspaceSlug,
    hasCollections,
    canManage,
    loadRepos,
    loadCollections,
    loadSpawnGrants,
    loadMcpAttachments,
    loadEnvBindings,
    loadSessions,
  ]);

  const breadcrumbs = [
    { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
    { label: "Agents", href: `/workspaces/${workspaceSlug}` },
    { label: agent?.name ?? agentSlug },
  ];

  if (!agent) {
    return (
      <AppShell breadcrumbs={breadcrumbs}>
        <div className="p-6 text-sm text-fg-faint">
          {bySlug[workspaceSlug] ? "Agent not found." : "Loading…"}
        </div>
      </AppShell>
    );
  }

  const repos = agentRepos[agent.id]?.repos ?? [];
  const mcpAttachmentCount =
    mcpAttachmentsByKey[mcpAgentKey(workspaceSlug, agent.id)]?.length ?? null;
  const envBindingCount =
    envBindingsByKey[`${workspaceSlug}:${agent.id}`]?.length ?? null;
  const attachmentKey = `${workspaceSlug}:${agent.id}`;
  const collections = attachmentsByKey[attachmentKey] ?? [];
  const spawnGrants = spawnByAgent[attachmentKey] ?? [];
  const sessions = sessionsByAgent[agent.id] ?? [];

  const editHref = `/workspaces/${workspaceSlug}/agents/${agent.slug}/edit`;

  return (
    <AppShell breadcrumbs={breadcrumbs}>
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold text-fg">
              {agent.name}
            </h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-fg-faint">
              <code className="font-mono">{agent.slug}</code>
              <span>·</span>
              <span>{agent.runtime_type}</span>
              <span>·</span>
              <AgentRuntimeBadge
                isActive={agent.is_active}
                sessions={sessions}
              />
            </div>
          </div>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              asChild
            >
              <a href={editHref}>Edit</a>
            </Button>
          )}
        </div>

        <SpawnSessionCard workspaceSlug={workspaceSlug} agentId={agent.id} />

        {/* X1A-37 — agent cost across every session in window.
            Admin-only on the server side; rendered for everyone but
            shows an empty state if the API 403s. 7d default locked. */}
        {canManage ? (
          <AgentCostCard workspaceSlug={workspaceSlug} agentId={agent.id} />
        ) : null}

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
              href={`${editHref}?tab=connections`}
              disabled={!canManage}
              label="Repositories"
              value={
                repos.length === 0
                  ? "None attached"
                  : `${repos.length} attached`
              }
              muted={repos.length === 0}
            />
            {/* Collections only when the deployment has a graph
                provider — same gate the Connections tab and the
                sidebar use. Avoids surfacing a feature the cluster
                cannot back. */}
            {hasCollections && (
              <SummaryRow
                href={`${editHref}?tab=connections`}
                disabled={!canManage}
                label="Collections"
                value={
                  collections.length === 0
                    ? "None attached"
                    : `${collections.length} attached`
                }
                muted={collections.length === 0}
              />
            )}
            <SummaryRow
              href={`${editHref}?tab=connections`}
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
              href={`${editHref}?tab=connections`}
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
      <span className="text-sm text-fg-muted">{label}</span>
      <span
        className={`ml-auto truncate text-sm ${
          muted ? "text-fg-faint/70" : "text-fg"
        }`}
      >
        {value}
      </span>
      {!disabled && (
        <ChevronRight className="size-4 shrink-0 text-fg-faint/40 group-hover:text-fg-muted" />
      )}
    </>
  );

  const base = `group flex items-center gap-3 px-4 py-3 ${
    last ? "" : "border-b border-border-soft"
  }`;
  if (disabled) {
    return <div className={base}>{content}</div>;
  }
  return (
    <a href={href} className={`${base} hover:bg-bg-elevated/40`}>
      {content}
    </a>
  );
}
