import { useEffect } from "react";
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
import { AgentReposSection } from "../github/AgentReposSection";
import { RecentRunsSection } from "../sessions/RecentRunsSection";
import { CanSpawnCard } from "./CanSpawnCard";

interface Props {
  workspaceSlug: string;
  agentSlug: string;
}

export function AgentDetailRoot({ workspaceSlug, agentSlug }: Props) {
  const { status, memberships, fetchMe } = useAuthStore();
  const { bySlug, load } = useAgentsStore();

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

  return (
    <AppShell
      breadcrumbs={breadcrumbs}
      actions={
        canManage ? (
          <Button variant="outline" size="sm" asChild>
            <a href={`/workspaces/${workspaceSlug}/agents/${agent.slug}/edit`}>
              Edit
            </a>
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6 p-6 max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{agent.name}</h1>
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
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
            <CardDescription>
              {agent.schedule
                ? "Scheduler ticks this agent on the cadence below."
                : "Manual only — no cron set."}
            </CardDescription>
          </CardHeader>
          {agent.schedule && (
            <CardContent>
              <code className="rounded bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-200">
                {agent.schedule}
              </code>
            </CardContent>
          )}
        </Card>

        {agent.system_prompt.trim() && (
          <Card>
            <CardHeader>
              <CardTitle>System prompt</CardTitle>
              <CardDescription>
                Applied on every session regardless of trigger.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap rounded-md border border-zinc-900 bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
                {agent.system_prompt}
              </pre>
            </CardContent>
          </Card>
        )}

        {agent.schedule && agent.heartbeat_md.trim() && (
          <Card>
            <CardHeader>
              <CardTitle>Heartbeat instructions</CardTitle>
              <CardDescription>
                First user message on every scheduler tick.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap rounded-md border border-zinc-900 bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
                {agent.heartbeat_md}
              </pre>
            </CardContent>
          </Card>
        )}

        <AgentReposSection workspaceSlug={workspaceSlug} agentId={agent.id} />

        <CanSpawnCard
          workspaceSlug={workspaceSlug}
          parentAgentId={agent.id}
          parentAgentName={agent.name}
          canManage={!!canManage}
        />

        <RecentRunsSection workspaceSlug={workspaceSlug} agentId={agent.id} />
      </div>
    </AppShell>
  );
}
