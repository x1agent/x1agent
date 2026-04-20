import { useEffect, useState } from "react";
import type { RuntimeType } from "@x1agent/shared";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
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
import { apiFetch } from "../../lib/api";
import { useAuthStore } from "../../stores/authStore";
import { useAgentsStore } from "../../stores/agentsStore";

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
  const [imageId, setImageId] = useState<string>("");
  const [images, setImages] = useState<
    Array<{
      id: string;
      name: string;
      display_name: string;
      description: string | null;
      is_preset: boolean;
    }>
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  useEffect(() => {
    apiFetch<{ images: typeof images }>(
      `/api/workspaces/${workspaceSlug}/agent-images`,
    )
      .then((body) => setImages(body.images ?? []))
      .catch(() => setImages([]));
  }, [workspaceSlug]);

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
      setImageId((existing as { image_id?: string | null }).image_id ?? "");
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

  const breadcrumbs = isCreate
    ? [
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "Agents", href: `/workspaces/${workspaceSlug}` },
        { label: "New" },
      ]
    : [
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "Agents", href: `/workspaces/${workspaceSlug}` },
        {
          label: existing?.name ?? agentSlug ?? "Agent",
          href: `/workspaces/${workspaceSlug}/agents/${agentSlug}`,
        },
        { label: "Edit" },
      ];

  const cancelHref = isCreate
    ? `/workspaces/${workspaceSlug}`
    : `/workspaces/${workspaceSlug}/agents/${agentSlug}`;

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
        window.location.href = `/workspaces/${workspaceSlug}/agents/${slugInput.trim()}`;
      } else if (existing) {
        await update(workspaceSlug, existing.id, {
          name: name.trim(),
          runtime_type: runtimeType,
          system_prompt: systemPrompt,
          heartbeat_md: heartbeatMd,
          schedule: schedule.trim() ? schedule.trim() : null,
          is_active: isActive,
          image_id: imageId === "" ? null : imageId,
        } as never);
        window.location.href = `/workspaces/${workspaceSlug}/agents/${existing.slug}`;
      }
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
    <AppShell breadcrumbs={breadcrumbs}>
      <form onSubmit={onSubmit} className="space-y-6 p-6 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Heartbeat"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-slug">Slug</Label>
              <Input
                id="agent-slug"
                required
                disabled={!isCreate}
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value)}
                placeholder="heartbeat"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-runtime">Runtime</Label>
              <Select
                value={runtimeType}
                onValueChange={(v) => setRuntimeType(v as RuntimeType)}
              >
                <SelectTrigger id="agent-runtime">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude_code">claude_code</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-image">Container image</Label>
              <Select
                value={imageId === "" ? "__default__" : imageId}
                onValueChange={(v) =>
                  setImageId(v === "__default__" ? "" : v)
                }
              >
                <SelectTrigger id="agent-image">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    Platform default
                  </SelectItem>
                  {images.map((img) => (
                    <SelectItem key={img.id} value={img.id}>
                      {img.display_name}
                      {img.is_preset ? " (preset)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-500">
                Pick a preset or a workspace image. "Platform default"
                uses the deployment-wide AGENT_IMAGE and is appropriate
                for the generic node-based agent.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
            <CardDescription>
              Cron expression or macro like <code>@hourly</code> or{" "}
              <code>@every 15m</code>. Leave blank for manual runs only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              id="agent-schedule"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="@hourly, @every 15m, or 0 9 * * mon-fri"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System prompt</CardTitle>
            <CardDescription>
              Applied on every session regardless of trigger. Runtime
              instructions that change per task live in the repo's own
              CLAUDE.md, cloned into /workspace at session start.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              id="agent-system"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={6}
            />
          </CardContent>
        </Card>

        {schedule.trim() && (
          <Card>
            <CardHeader>
              <CardTitle>Heartbeat instructions</CardTitle>
              <CardDescription>
                Sent as the first user message on every scheduler tick.
                Only relevant because a cadence is set — manual-only
                agents wait for you to type in the session.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                id="agent-heartbeat"
                value={heartbeatMd}
                onChange={(e) => setHeartbeatMd(e.target.value)}
                rows={8}
                placeholder="Every tick: read the latest dashboard, summarize changes, post to #ops."
                className="font-mono text-xs"
              />
            </CardContent>
          </Card>
        )}

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

        {error && <div className="text-sm text-red-400">{error}</div>}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : isCreate ? "Create agent" : "Save"}
          </Button>
          <Button type="button" variant="outline" asChild>
            <a href={cancelHref}>Cancel</a>
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
