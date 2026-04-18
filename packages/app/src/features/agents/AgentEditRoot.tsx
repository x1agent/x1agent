import { useEffect, useState } from "react";
import type { RuntimeType } from "@x1agent/shared";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Card,
  CardContent,
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
import { useAuthStore } from "../../stores/authStore";
import { useAgentsStore } from "../../stores/agentsStore";
import { AgentReposSection } from "../github/AgentReposSection";

interface Props {
  workspaceSlug: string;
  /** undefined for create mode. */
  agentSlug?: string;
}

export function AgentEditRoot({ workspaceSlug, agentSlug }: Props) {
  const { status, memberships, fetchMe } = useAuthStore();
  const { bySlug, load, create, update, remove } = useAgentsStore();
  const isCreate = !agentSlug;

  const [name, setName] = useState("");
  const [slugInput, setSlugInput] = useState("");
  const [runtimeType, setRuntimeType] = useState<RuntimeType>("claude_code");
  const [schedule, setSchedule] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [heartbeatMd, setHeartbeatMd] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  const existing =
    !isCreate && agentSlug
      ? (bySlug[workspaceSlug] ?? []).find((a) => a.slug === agentSlug)
      : undefined;

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setSlugInput(existing.slug);
      setRuntimeType(existing.runtime_type);
      setSchedule(existing.schedule ?? "");
      setSystemPrompt(existing.system_prompt);
      setHeartbeatMd(existing.heartbeat_md);
      setIsActive(existing.is_active);
    }
  }, [existing]);

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  const ws = memberships.find((m) => m.slug === workspaceSlug);
  const canManage = ws?.role === "admin" || ws?.role === "owner";
  if (ws && !canManage) {
    return (
      <AppShell>
        <div className="p-8 text-sm text-zinc-400">
          You need admin role to manage agents.
        </div>
      </AppShell>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isCreate) {
        await create(workspaceSlug, {
          slug: slugInput.trim(),
          name: name.trim(),
          runtime_type: runtimeType,
          system_prompt: systemPrompt,
          heartbeat_md: heartbeatMd,
          schedule: schedule.trim() ? schedule.trim() : null,
        });
      } else if (existing) {
        await update(workspaceSlug, existing.id, {
          name: name.trim(),
          runtime_type: runtimeType,
          system_prompt: systemPrompt,
          heartbeat_md: heartbeatMd,
          schedule: schedule.trim() ? schedule.trim() : null,
          is_active: isActive,
        });
      }
      window.location.href = `/workspaces/${workspaceSlug}`;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async () => {
    if (!existing) return;
    if (!confirm(`Delete agent ${existing.name}?`)) return;
    await remove(workspaceSlug, existing.id);
    window.location.href = `/workspaces/${workspaceSlug}`;
  };

  return (
    <AppShell>
      <form onSubmit={onSubmit} className="p-8 space-y-6 max-w-2xl">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            {isCreate ? "New agent" : "Edit agent"}
          </div>
          <h1 className="text-2xl font-semibold">{name || "Untitled"}</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="agent-name" className="mb-1 block">
                Name
              </Label>
              <Input
                id="agent-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Heartbeat"
              />
            </div>
            <div>
              <Label htmlFor="agent-slug" className="mb-1 block">
                Slug
              </Label>
              <Input
                id="agent-slug"
                required
                disabled={!isCreate}
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value)}
                placeholder="heartbeat"
              />
            </div>
            <div>
              <Label className="mb-1 block">Runtime</Label>
              <Select
                value={runtimeType}
                onValueChange={(v) => setRuntimeType(v as RuntimeType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude_code">claude_code</SelectItem>
                  <SelectItem value="mastra">mastra</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <Label htmlFor="agent-schedule" className="mb-1 block">
              Cron or macro
            </Label>
            <Input
              id="agent-schedule"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="@hourly, @every 15m, or 0 9 * * mon-fri"
            />
            <div className="mt-2 text-xs text-zinc-500">
              Leave blank for manual runs only.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prompts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="agent-system" className="mb-1 block">
                System prompt
              </Label>
              <textarea
                id="agent-system"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={4}
                className="flex w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-zinc-500 focus-visible:outline-none"
              />
            </div>
            <div>
              <Label htmlFor="agent-heartbeat" className="mb-1 block">
                heartbeat.md
              </Label>
              <textarea
                id="agent-heartbeat"
                value={heartbeatMd}
                onChange={(e) => setHeartbeatMd(e.target.value)}
                rows={8}
                placeholder="Instructions the agent reads on every scheduled tick."
                className="flex w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus-visible:border-zinc-500 focus-visible:outline-none"
              />
            </div>
          </CardContent>
        </Card>

        {!isCreate && (
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                Active (runs on schedule)
              </label>
            </CardContent>
          </Card>
        )}

        <AgentReposSection
          workspaceSlug={workspaceSlug}
          agentId={existing?.id ?? null}
        />

        {error && <div className="text-sm text-red-400">{error}</div>}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : isCreate ? "Create agent" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            asChild
          >
            <a href={`/workspaces/${workspaceSlug}`}>Cancel</a>
          </Button>
          {!isCreate && (
            <Button
              type="button"
              variant="destructive"
              onClick={onDelete}
              className="ml-auto"
            >
              Delete
            </Button>
          )}
        </div>
      </form>
    </AppShell>
  );
}
