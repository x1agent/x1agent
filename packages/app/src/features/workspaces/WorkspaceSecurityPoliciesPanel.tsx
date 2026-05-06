import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import {
  useWorkspaceSettingsStore,
  type OauthMcpsOnOrchestratorsMode,
} from "../../stores/workspaceSettingsStore";

interface Props {
  slug: string;
  canManage: boolean;
}

interface ModeOption {
  value: OauthMcpsOnOrchestratorsMode;
  title: string;
  blurb: string;
}

const MODE_OPTIONS: readonly ModeOption[] = [
  {
    value: "off",
    title: "Off",
    blurb:
      "Block attaching OAuth MCPs (Mercury, Notion, Google, etc.) to orchestrator and scheduled agents. Workers are unaffected. Safe default.",
  },
  {
    value: "on_attended",
    title: "On — interactive runs only",
    blurb:
      "Allow attaching OAuth MCPs to orchestrator agents. The runtime injects the triggering user's token only for sessions started manually from the UI. Cron- and parent-spawned runs that hit an OAuth MCP receive `permission_required` cleanly so the agent can react.",
  },
  {
    value: "on",
    title: "On — all runs",
    blurb:
      "Reserved. Behaves like `On — interactive runs only` today; later releases will fall back to a workspace-designated user's tokens for unattended runs. Pick this if you want that behavior the moment it lands without re-configuring.",
  },
];

export function WorkspaceSecurityPoliciesPanel({ slug, canManage }: Props) {
  const ws = useWorkspaceSettingsStore((s) => s.bySlug[slug]);
  const status = useWorkspaceSettingsStore((s) => s.statusBySlug[slug] ?? "idle");
  const load = useWorkspaceSettingsStore((s) => s.load);
  const patch = useWorkspaceSettingsStore((s) => s.patch);

  const [pending, setPending] = useState<OauthMcpsOnOrchestratorsMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void load(slug);
  }, [slug, load]);

  const current: OauthMcpsOnOrchestratorsMode =
    ws?.settings.oauthMcpsOnOrchestrators ?? "off";

  async function onPick(value: OauthMcpsOnOrchestratorsMode) {
    if (!canManage || pending) return;
    if (value === current) return;
    setError(null);
    setPending(value);
    try {
      await patch(slug, { oauthMcpsOnOrchestrators: value });
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  if (status === "loading" || status === "idle") {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-fg-muted">
          Loading workspace settings…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>OAuth MCPs on orchestrator agents</CardTitle>
          <CardDescription>
            Whether agents whose kind is <code>orchestrator</code> or{" "}
            <code>scheduled</code> may attach MCPs that authenticate as
            the driving user (Mercury, Notion, Google, etc.). Worker
            agents are never affected — they always have a present
            user.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {MODE_OPTIONS.map((opt) => {
            const checked = current === opt.value;
            const disabled = !canManage || (!!pending && pending !== opt.value);
            return (
              <label
                key={opt.value}
                className={[
                  "flex cursor-pointer gap-3 rounded border p-3 text-sm",
                  checked
                    ? "border-accent bg-accent/5"
                    : "border-border-soft hover:border-border",
                  disabled ? "cursor-not-allowed opacity-60" : "",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="oauthMcpsOnOrchestrators"
                  className="mt-0.5"
                  value={opt.value}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onPick(opt.value)}
                />
                <span className="space-y-1">
                  <span className="block font-medium text-fg">
                    {opt.title}
                  </span>
                  <span className="block text-fg-muted">{opt.blurb}</span>
                </span>
              </label>
            );
          })}

          {!canManage && (
            <p className="text-xs text-fg-faint">
              Only workspace admins and owners can change this setting.
            </p>
          )}
          {error && (
            <p className="text-xs text-rose-500">Failed to save: {error}</p>
          )}
          {savedAt && !error && pending === null && (
            <p className="text-xs text-emerald-500">Saved.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Why this exists</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-fg-muted">
          <p>
            Worker agents always run with a present user driving the
            session — their OAuth tokens are available for the whole
            run. Orchestrators don't have that guarantee: they wake on
            cron schedules, they get spawned by other orchestrators,
            and they can run for hours with no human in the loop.
          </p>
          <p>
            Allowing OAuth MCPs on orchestrators means the platform may
            be acting on a user's behalf at 3am while the user sleeps.
            That's the right tradeoff for some workspaces (interactive
            co-driving, long-form planning sessions) and the wrong one
            for others (strict-compliance customers, multi-tenant
            installs). This setting puts the choice on the workspace
            admin, where it belongs.
          </p>
          <p>
            <Button variant="link" asChild className="h-auto p-0">
              <a href="/docs/architecture/sidecar/" target="_blank" rel="noreferrer">
                More on the credential proxy →
              </a>
            </Button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
