import { useEffect, useState } from "react";
import type { RuntimeType } from "@x1agent/shared";
import { slugify } from "@x1agent/kernel";
import { apiFetch } from "../../lib/api";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";
import { useAuthStore } from "../../stores/authStore";
import { useAgentsStore } from "../../stores/agentsStore";
import { useImagesStore, type AgentImage } from "../../stores/imagesStore";

// Stable empty array reference for the images selector. Returning a
// fresh `[]` from a zustand selector defeats React's identity check
// and causes downstream effects/memos to re-run on every render.
const EMPTY_IMAGES: ReadonlyArray<AgentImage> = [];
import {
  useCapabilitiesStore,
  useHasCollections,
} from "../../stores/capabilitiesStore";
import { useUrlSearchParam } from "../../lib/useUrlSearchParam";
import { AgentReposSection } from "../github/AgentReposSection";
import { CollectionsAttachCard } from "./CollectionsAttachCard";
import { CanSpawnCard } from "./CanSpawnCard";
import { AgentCollaboratorsCard } from "./AgentCollaboratorsCard";
import { AgentMcpAttachmentsCard } from "./AgentMcpAttachmentsCard";
import { AgentEnvBindingsCard } from "./AgentEnvBindingsCard";
import { AgentSlackBotCard } from "./AgentSlackBotCard";
import { ScheduleBuilder } from "../../components/schedule/ScheduleBuilder";
import { SpawnSessionCard } from "../sessions/SpawnSessionCard";
import { useConfirm } from "../../components/use-confirm";

interface Props {
  workspaceSlug: string;
  /** undefined for create mode. */
  agentSlug?: string;
}

/**
 * Agent edit screen. Divided into tabs so the detail page can stay
 * compact: General (identity + schedule + active), Prompts (system +
 * heartbeat), Repositories, Collections, Permissions. The tab is
 * URL-synced so summary-row links on the detail page can deep-link
 * straight into the right section.
 *
 * Create mode only shows General + Prompts — the others require an
 * agent id that doesn't exist yet. After create, the user lands on
 * the detail page and can attach repos/collections/grants from there.
 */

type TabKey = "general" | "prompts" | "connections" | "permissions";

const DEFAULT_TAB: TabKey = "general";

// Pre-IA-collapse tab values that older deep-links may still carry.
// Map them onto "connections" so a stale URL lands on the right place.
const LEGACY_CONNECTION_TABS: ReadonlySet<string> = new Set([
  "repos",
  "collections",
  "mcp",
  "slack",
]);

function isTabKey(value: string): value is TabKey {
  return (
    value === "general" ||
    value === "prompts" ||
    value === "connections" ||
    value === "permissions"
  );
}

function normalizeTab(raw: string): TabKey {
  if (LEGACY_CONNECTION_TABS.has(raw)) return "connections";
  return isTabKey(raw) ? raw : DEFAULT_TAB;
}

export function AgentEditRoot({ workspaceSlug, agentSlug }: Props) {
  // Subscribe to one field at a time. Destructuring the whole store
  // (`useAuthStore()` / `useAgentsStore()` with no selector) re-renders
  // this component on every set() against either store — and during the
  // mount sequence each store ticks 2-3 times (status: idle → loading →
  // authenticated; bySlug: empty → populated). The extra renders shake
  // any unstable selector / memo / ref-callback identity downstream,
  // which is exactly how the agents/new page kept tripping React error
  // #185 (see fadab8c — same shape, different selector).
  const status = useAuthStore((s) => s.status);
  const memberships = useAuthStore((s) => s.memberships);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const isPlatformAdmin = useAuthStore((s) => s.isPlatformAdmin);
  const currentUser = useAuthStore((s) => s.user);
  const bySlug = useAgentsStore((s) => s.bySlug);
  const load = useAgentsStore((s) => s.load);
  const create = useAgentsStore((s) => s.create);
  const update = useAgentsStore((s) => s.update);
  const remove = useAgentsStore((s) => s.remove);
  const isCreate = !agentSlug;

  const [name, setName] = useState("");
  const [slugInput, setSlugInput] = useState("");
  // Tracks whether the user has manually edited the slug. While false (in
  // create mode), the slug auto-tracks the name. Once true, manual edits
  // win. Clearing the slug field re-enables auto-tracking.
  const [slugDirty, setSlugDirty] = useState(false);
  const [runtimeType, setRuntimeType] = useState<RuntimeType>("claude_code");
  const [kind, setKind] = useState<"worker" | "orchestrator" | "scheduled">(
    "worker",
  );
  const [schedule, setSchedule] = useState("");
  // User the scheduler should impersonate when this agent's cron tick
  // fires. Defaults to the current admin (= creator) on create. The
  // /members endpoint populates the picker; null means "no run-as
  // user" (rare — only valid for agents with no schedule + no
  // remote_oauth MCPs).
  const [scheduledRunAsUserId, setScheduledRunAsUserId] = useState<string>("");
  const [workspaceMembers, setWorkspaceMembers] = useState<
    { user_id: string; email: string; name: string }[]
  >([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [heartbeatMd, setHeartbeatMd] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [imageId, setImageId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  // Per-agent idle timeout in seconds. Empty string = use platform
  // default (1 h workers / scheduled, 7 d orchestrators).
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState<string>("");
  // Model catalog comes from /api/capabilities/anthropic/models so the
  // frontend doesn't hardcode model ids. Empty list = upstream
  // unreachable; UI falls back to a free-text input.
  const [modelCatalog, setModelCatalog] = useState<
    { id: string; label: string }[]
  >([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  // Selector returns the cached array, never a freshly-allocated `[]`
  // -- React's identity check then sees a stable reference across
  // renders and any effect / memo depending on `images` doesn't loop.
  // The `?? []` foot-gun (per CLAUDE.md "Selector foot-gun") goes here,
  // INSIDE the selector, not outside.
  const images = useImagesStore((s) => s.bySlug[workspaceSlug] ?? EMPTY_IMAGES);
  const loadImages = useImagesStore((s) => s.load);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [tabRaw, setTab] = useUrlSearchParam("tab", DEFAULT_TAB);
  const tab: TabKey = normalizeTab(tabRaw);

  const fetchCapabilities = useCapabilitiesStore((s) => s.fetch);
  const hasCollections = useHasCollections();

  useEffect(() => {
    if (status === "idle") fetchMe();
    fetchCapabilities();
    void apiFetch<{
      models: { id: string; label: string }[];
      default: string | null;
    }>("/api/capabilities/anthropic/models")
      .then((r) => {
        setModelCatalog(r.models);
        setDefaultModel(r.default);
      })
      .catch(() => {
        // Upstream Vertex/Anthropic unreachable — fall back to free-text.
      });
  }, [status, fetchMe, fetchCapabilities]);

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  useEffect(() => {
    loadImages(workspaceSlug);
  }, [workspaceSlug, loadImages]);

  // On create, default scheduled-run-as to the current user (= creator).
  // Edit mode loads the existing value below.
  //
  // Gated on workspaceMembers being populated AND containing the
  // current user. Setting the value before the SelectItem with that
  // value mounts trips a Radix Select infinite-render bug when other
  // controlled Selects on the page are mid-mount — see X1A-85 / Sentry
  // X1AGENT-APP-C. The cheapest fix is to never put a value into the
  // Select that doesn't have a matching <SelectItem> at the same render.
  useEffect(() => {
    if (
      isCreate &&
      currentUser &&
      !scheduledRunAsUserId &&
      workspaceMembers.some((m) => m.user_id === currentUser.id)
    ) {
      setScheduledRunAsUserId(currentUser.id);
    }
  }, [isCreate, currentUser, scheduledRunAsUserId, workspaceMembers]);

  // Workspace members for the "Run as" picker on the Schedule card.
  // Only fetched when this user has admin/owner role — non-admins
  // can't edit agents anyway and the API would 403. One fetch per
  // workspace mount; the list is small (typically <20 users) so we
  // don't bother caching across mounts.
  useEffect(() => {
    void apiFetch<{
      members: { user_id: string; email: string; name: string }[];
    }>(`/api/workspaces/${workspaceSlug}/members`)
      .then((r) => setWorkspaceMembers(r.members))
      .catch(() => {
        // 403 (non-admin) or transient — picker falls back to a
        // single "creator" option. Form still saves; the API
        // membership-check on the create/update path is the real
        // guard.
      });
  }, [workspaceSlug]);

  const workspaceAgents = bySlug[workspaceSlug];
  const existing =
    !isCreate && agentSlug && workspaceAgents
      ? workspaceAgents.find((a) => a.slug === agentSlug)
      : undefined;

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setSlugInput(existing.slug);
      setRuntimeType(existing.runtime_type);
      if (
        existing.kind === "worker" ||
        existing.kind === "orchestrator" ||
        existing.kind === "scheduled"
      ) {
        setKind(existing.kind);
      }
      setSchedule(existing.schedule ?? "");
      setSystemPrompt(existing.system_prompt);
      setHeartbeatMd(existing.heartbeat_md);
      setIsActive(existing.is_active);
      setImageId((existing as { image_id?: string | null }).image_id ?? "");
      setModel((existing as { model?: string | null }).model ?? "");
      setScheduledRunAsUserId(
        (existing as { scheduled_run_as_user_id?: string | null })
          .scheduled_run_as_user_id ?? "",
      );
      const its = (existing as { idle_timeout_seconds?: number | null })
        .idle_timeout_seconds;
      setIdleTimeoutSeconds(its == null ? "" : String(its));
    }
  }, [existing]);

  // Codex requires its dedicated runtime image. Once the platform preset
  // catalog arrives, select that image automatically for a new Codex agent
  // unless the operator has already chosen an image explicitly.
  useEffect(() => {
    if (isCreate && runtimeType === "codex" && imageId === "") {
      const codexImage = images.find(
        (image) => image.is_preset && image.name === "runtime-codex",
      );
      if (codexImage) setImageId(codexImage.id);
    }
  }, [imageId, images, isCreate, runtimeType]);

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  const ws = memberships.find((m) => m.slug === workspaceSlug);
  const canManage = ws?.role === "admin" || ws?.role === "owner";
  if (ws && !canManage) {
    return (
      <AppShell>
        <div className="p-8 text-sm text-fg-muted">
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
          kind,
          system_prompt: systemPrompt,
          heartbeat_md: heartbeatMd,
          image_id: imageId === "" ? null : imageId,
          model: model.trim() === "" ? null : model.trim(),
          schedule: schedule.trim() ? schedule.trim() : null,
          scheduled_run_as_user_id: scheduledRunAsUserId || null,
          idle_timeout_seconds: idleTimeoutSeconds.trim() === ""
            ? null
            : Number(idleTimeoutSeconds),
        } as never);
        window.location.href = `/workspaces/${workspaceSlug}/agents/${slugInput.trim()}`;
      } else if (existing) {
        await update(workspaceSlug, existing.id, {
          name: name.trim(),
          runtime_type: runtimeType,
          kind,
          system_prompt: systemPrompt,
          heartbeat_md: heartbeatMd,
          schedule: schedule.trim() ? schedule.trim() : null,
          is_active: isActive,
          image_id: imageId === "" ? null : imageId,
          model: model.trim() === "" ? null : model.trim(),
          scheduled_run_as_user_id: scheduledRunAsUserId || null,
          idle_timeout_seconds: idleTimeoutSeconds.trim() === ""
            ? null
            : Number(idleTimeoutSeconds),
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
    const ok = await confirm({
      title: `Delete agent ${existing.name}?`,
      description:
        "This removes the agent and its configuration. Past sessions are kept; future runs will fail until you recreate it.",
      confirmText: "Delete",
    });
    if (!ok) return;
    await remove(workspaceSlug, existing.id);
    window.location.href = `/workspaces/${workspaceSlug}`;
  };

  // Save bar is shown under the General + Prompts tabs — those tabs
  // edit the agent row itself. Repos / Collections / Permissions each
  // save independently via their own cards and don't go through this
  // form submit.
  const showSaveBar = tab === "general" || tab === "prompts";

  return (
    <AppShell breadcrumbs={breadcrumbs}>
      {confirmDialog}
      <div className="max-w-3xl p-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v)}>
          <TabsList className="mb-4">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
            {!isCreate && (
              <>
                <TabsTrigger value="connections">Connections</TabsTrigger>
                <TabsTrigger value="permissions">Permissions</TabsTrigger>
              </>
            )}
          </TabsList>

          <form onSubmit={onSubmit} className="space-y-6">
            <TabsContent value="general" className="mt-0 space-y-6">
              {!isCreate && existing && (
                <SpawnSessionCard
                  workspaceSlug={workspaceSlug}
                  agentId={existing.id}
                />
              )}

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
                      onChange={(e) => {
                        const v = e.target.value;
                        setName(v);
                        if (isCreate && !slugDirty) {
                          setSlugInput(slugify(v));
                        }
                      }}
                      placeholder="Researcher"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="agent-slug">Slug</Label>
                    <Input
                      id="agent-slug"
                      required
                      disabled={!isCreate}
                      value={slugInput}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSlugInput(v);
                        // Manual edit takes over auto-tracking. Clearing
                        // the field re-enables auto-tracking so the user
                        // can recover from a mistake without retyping.
                        setSlugDirty(v !== "" && v !== slugify(name));
                      }}
                      placeholder="researcher"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                          <SelectItem value="claude_code">
                            claude_code
                          </SelectItem>
                          <SelectItem value="codex">codex</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="agent-kind">Kind</Label>
                      <Select
                        value={kind}
                        onValueChange={(v) =>
                          setKind(
                            v as "worker" | "orchestrator" | "scheduled",
                          )
                        }
                      >
                        <SelectTrigger id="agent-kind">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="worker">worker</SelectItem>
                          <SelectItem value="orchestrator">orchestrator</SelectItem>
                          <SelectItem value="scheduled">scheduled</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-fg-faint">
                        {kind === "worker"
                          ? "Short-lived, one session per trigger."
                          : kind === "orchestrator"
                            ? "Long-lived singleton with platform-driven wakes."
                            : "Cron-triggered worker."}
                      </p>
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

                          {/* General — non-language-toolchain presets (today: just runtime-core). */}
                          {(() => {
                            const general = images.filter(
                              (img) =>
                                img.is_preset && img.name === "runtime-core",
                            );
                            if (general.length === 0) return null;
                            return (
                              <SelectGroup>
                                <SelectLabel>General</SelectLabel>
                                {general.map((img) => (
                                  <SelectItem key={img.id} value={img.id}>
                                    {/* Override the seeded display name in case
                                        an existing deployment still has the old
                                        "x1 runtime core" label. */}
                                    {img.name === "runtime-core"
                                      ? "Lightweight (no language toolchain)"
                                      : img.display_name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            );
                          })()}

                          {/* Coding — language-toolchain presets. */}
                          {(() => {
                            const coding = images.filter(
                              (img) =>
                                img.is_preset && img.name !== "runtime-core",
                            );
                            if (coding.length === 0) return null;
                            return (
                              <SelectGroup>
                                <SelectLabel>Coding</SelectLabel>
                                {coding.map((img) => (
                                  <SelectItem key={img.id} value={img.id}>
                                    {img.display_name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            );
                          })()}

                          {/* Workspace-authored images — non-preset. We
                              SHOW transient build states (pending /
                              building) so an agent that's pinned to an
                              image being rebuilt doesn't lose its
                              binding mid-rebuild — Select's `value`
                              would no longer match any option, the
                              dropdown would visually revert to
                              "Platform default", and the next save
                              would persist image_id=NULL. Failed
                              builds are still hidden — spawning
                              against a failed image is a guaranteed
                              ImagePullBackOff. The same defense lives
                              on the spawn path: pod-spec falls back to
                              the platform default if built_ref is
                              empty, so picking a pending/building
                              image is safe until the build lands. */}
                          {(() => {
                            const workspace = images.filter(
                              (img) =>
                                !img.is_preset && img.build_status !== "failed",
                            );
                            if (workspace.length === 0) return null;
                            return (
                              <SelectGroup>
                                <SelectLabel>Workspace</SelectLabel>
                                {workspace.map((img) => {
                                  const suffix =
                                    img.build_status === "pending"
                                      ? " (queued)"
                                      : img.build_status === "building"
                                        ? " (building…)"
                                        : "";
                                  return (
                                    <SelectItem key={img.id} value={img.id}>
                                      {img.display_name}
                                      {suffix}
                                    </SelectItem>
                                  );
                                })}
                              </SelectGroup>
                            );
                          })()}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-xs text-fg-faint">
                    "Platform default" uses the deployment-wide AGENT_IMAGE;
                    pick a preset or a workspace image to override per agent.
                  </p>
                  <div className="space-y-1.5 pt-2">
                    <Label htmlFor="agent-model">
                      {runtimeType === "codex" ? "Codex model" : "Claude model"}
                    </Label>
                    {runtimeType === "codex" ? (
                      <Input
                        id="agent-model"
                        placeholder="gpt-5.3-codex"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                      />
                    ) : modelCatalog.length > 0 ? (
                      <Select
                        value={
                          model === ""
                            ? "__default__"
                            : modelCatalog.some((m) => m.id === model)
                              ? model
                              : "__custom__"
                        }
                        onValueChange={(v) => {
                          if (v === "__default__") setModel("");
                          else if (v === "__custom__") setModel(model || " ");
                          else setModel(v);
                        }}
                      >
                        <SelectTrigger id="agent-model">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">
                            Deployment default
                            {defaultModel ? ` (${defaultModel})` : ""}
                          </SelectItem>
                          {modelCatalog.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.label}
                            </SelectItem>
                          ))}
                          <SelectItem value="__custom__">Custom…</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="rounded-md border border-amber-900/50 bg-amber-950/30 p-3 text-xs text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-900">
                        No Claude models enabled in this deployment.{" "}
                        {isPlatformAdmin ? (
                          <>
                            Curate the list at{" "}
                            <a
                              href="/admin/anthropic-models"
                              className="underline"
                            >
                              /admin/anthropic-models
                            </a>
                            .
                          </>
                        ) : (
                          <>Ask a platform admin to enable one.</>
                        )}
                      </div>
                    )}
                    {runtimeType !== "codex" && modelCatalog.length > 0 &&
                      model !== "" &&
                      !modelCatalog.some((m) => m.id === model) && (
                        <Input
                          placeholder="claude-sonnet-4-5@20250929"
                          value={model.trim()}
                          onChange={(e) => setModel(e.target.value)}
                          className="mt-2"
                        />
                      )}
                    <p className="text-xs text-fg-faint">
                      {runtimeType === "codex"
                        ? "Codex uses the OpenAI model name entered here. Leave it blank to use the deployment default."
                        : "The list shows only models a platform admin has enabled at /admin/anthropic-models. The full Agent Platform (formerly Vertex AI) catalog is intentionally not exposed — it lists models that aren't actually servable in the deployment's region."}
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Schedule</CardTitle>
                  <CardDescription>
                    Pick a cadence or drop to a raw cron under Custom.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ScheduleBuilder value={schedule} onChange={setSchedule} />

                  {/* Run as: workspace user the scheduler impersonates
                      when this agent's cron tick fires. The credential
                      proxy mints per-user OAuth tokens against this id
                      at session-spawn time, so any Zone-3 MCPs the
                      agent has attached (Google Workspace, Linear, …)
                      run as this user. Defaults to the creator. */}
                  <div className="space-y-1.5 pt-2">
                    <Label htmlFor="agent-run-as">Run as</Label>
                    <Select
                      value={scheduledRunAsUserId || "__none__"}
                      onValueChange={(v) =>
                        setScheduledRunAsUserId(v === "__none__" ? "" : v)
                      }
                    >
                      <SelectTrigger id="agent-run-as">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          No run-as user (no scheduled runs)
                        </SelectItem>
                        {workspaceMembers.map((m) => (
                          <SelectItem key={m.user_id} value={m.user_id}>
                            {m.name || m.email}
                            {m.email !== m.name && m.name
                              ? ` (${m.email})`
                              : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-fg-faint">
                      The scheduler fires this agent's cron ticks as the
                      selected user — required for any agent with{" "}
                      <code>remote_oauth</code> MCPs attached (Google
                      Workspace, Linear, etc). Defaults to the agent's
                      creator. Workspace admins can change this to a
                      service account or another member.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Idle timeout</CardTitle>
                  <CardDescription>
                    How long the session pod waits for input before shutting itself down.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Label htmlFor="agent-idle-timeout">Seconds (blank = default)</Label>
                  <input
                    id="agent-idle-timeout"
                    type="number"
                    min={30}
                    max={604800}
                    step={30}
                    value={idleTimeoutSeconds}
                    onChange={(e) => setIdleTimeoutSeconds(e.target.value)}
                    placeholder={kind === "orchestrator" ? "604800 (default: 7 days)" : "3600 (default: 1 hour)"}
                    className="w-full rounded border border-border bg-bg-input px-2 py-1.5 text-sm"
                  />
                  <p className="text-xs text-fg-faint">
                    Range 30 s – 604800 s (7 days). Blank uses the platform default:{" "}
                    <strong>1 hour</strong> for worker / scheduled agents,{" "}
                    <strong>7 days</strong> for orchestrators. Bump it for interactive
                    sessions that idle while you read or step away; lower it for cron
                    agents that should die quickly after their work.
                  </p>
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
            </TabsContent>

            <TabsContent value="prompts" className="mt-0 space-y-6">
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
                    rows={10}
                  />
                </CardContent>
              </Card>

              {schedule.trim() ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Heartbeat instructions</CardTitle>
                    <CardDescription>
                      Sent as the first user message on every scheduler tick.
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
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Heartbeat instructions</CardTitle>
                    <CardDescription>
                      Available once a schedule is set. Set one on the General
                      tab to enable heartbeat prompts.
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            </TabsContent>

            {!isCreate && existing && (
              <>
                {/*
                 * Connections — every external thing this agent reads
                 * from or writes to. Stacked cards instead of N tabs:
                 * each kind is small enough that scrolling is faster
                 * than tab-switching, and the verb on each card stays
                 * focused (attach, link, bind, pair).
                 *
                 * Order is roughly "code first, tools second, data
                 * third, outputs last" — the natural reading order an
                 * admin scans when configuring a new agent.
                 */}
                <TabsContent value="connections" className="mt-0 space-y-6">
                  <AgentReposSection
                    workspaceSlug={workspaceSlug}
                    agentId={existing.id}
                  />

                  <AgentMcpAttachmentsCard
                    workspaceSlug={workspaceSlug}
                    agentId={existing.id}
                    agentKind={existing.kind}
                    canManage={!!canManage}
                  />

                  <AgentEnvBindingsCard
                    workspaceSlug={workspaceSlug}
                    agentId={existing.id}
                    canManage={!!canManage}
                  />

                  {hasCollections && (
                    <CollectionsAttachCard
                      workspaceSlug={workspaceSlug}
                      agentId={existing.id}
                      agentName={existing.name}
                      canManage={!!canManage}
                    />
                  )}

                  <AgentSlackBotCard
                    workspaceSlug={workspaceSlug}
                    agentId={existing.id}
                    canManage={!!canManage}
                  />
                </TabsContent>

                <TabsContent value="permissions" className="mt-0 space-y-6">
                  <AgentCollaboratorsCard
                    workspaceSlug={workspaceSlug}
                    agentId={existing.id}
                    agentName={existing.name}
                    visibility={
                      (existing as { visibility?: "private" | "workspace" | "via_grants" })
                        .visibility ?? "workspace"
                    }
                    canManage={!!canManage}
                    onVisibilityChanged={() => load(workspaceSlug)}
                  />
                  <CanSpawnCard
                    workspaceSlug={workspaceSlug}
                    parentAgentId={existing.id}
                    parentAgentName={existing.name}
                    canManage={!!canManage}
                  />
                </TabsContent>
              </>
            )}

            {error && <div className="text-sm text-red-400">{error}</div>}

            {showSaveBar && (
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting
                    ? "Saving…"
                    : isCreate
                      ? "Create agent"
                      : "Save"}
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
            )}
          </form>
        </Tabs>
      </div>
    </AppShell>
  );
}
