import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Badge } from "../../components/ui/badge";
import { useConfirm } from "../../components/use-confirm";
import { useSlackStore, type SlackBotDTO } from "../../stores/slackStore";
import { useAgentsStore } from "../../stores/agentsStore";

interface Props {
  slug: string;
  canManage: boolean;
}

/**
 * Workspace settings → Integrations → Slack.
 *
 * Lists configured Slack bots, lets a workspace admin add a new one
 * via the manifest URL flow, and shows the install state per bot.
 * Pairing with an agent happens here too — the picker filters to
 * agents in this workspace and surfaces "unpaired" status visually.
 */
export function WorkspaceSlackPanel({ slug, canManage }: Props) {
  const { configuredByWorkspace, botsByWorkspace, status, error, load } =
    useSlackStore();
  const configured = configuredByWorkspace[slug];
  const bots = botsByWorkspace[slug] ?? [];

  useEffect(() => {
    load(slug);
  }, [slug, load]);

  // Reload after Slack bounces the operator back with ?slack_installed=1.
  // The install row only appears post-callback, so the list is otherwise
  // stale until the next manual refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("slack_installed") === "1") {
      url.searchParams.delete("slack_installed");
      window.history.replaceState({}, "", url.toString());
      load(slug);
    }
  }, [slug, load]);

  if (status === "loading" && bots.length === 0) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-fg-muted">
          Loading Slack bots…
        </CardContent>
      </Card>
    );
  }

  if (status === "error") {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-fg-muted">
          Slack: {error ?? "failed to load"}
        </CardContent>
      </Card>
    );
  }

  if (configured === false) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Slack</CardTitle>
          <CardDescription>
            Slack is not configured on this server. The operator needs to
            register the platform Slack app and set{" "}
            <code className="mx-1 rounded bg-bg-elevated px-1 py-0.5 text-xs">
              SLACK_PLATFORM_*
            </code>
            on the api deployment. See the docs for the full steps.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const needsSecret = bots.filter(
    (b) => b.installs.length > 0 && !b.has_signing_secret,
  );

  return (
    <div className="space-y-4">
      {canManage && needsSecret.length > 0 && (
        <SigningSecretCard slug={slug} bots={needsSecret} />
      )}
      {canManage && <AddBotCard slug={slug} />}
      <BotsList slug={slug} bots={bots} canManage={canManage} />
    </div>
  );
}

function SigningSecretCard({
  slug,
  bots,
}: {
  slug: string;
  bots: SlackBotDTO[];
}) {
  return (
    <Card className="border-warning bg-warning/5">
      <CardHeader>
        <CardTitle>Almost done</CardTitle>
        <CardDescription>
          Slack created {bots.length === 1 ? "the bot" : `${bots.length} bots`},
          but the OAuth flow doesn't return the signing secret. Paste it below
          for each bot — it lives at{" "}
          <span className="font-mono">
            api.slack.com/apps/&lt;app id&gt; → Basic Information → Signing
            Secret
          </span>
          . Without it the events endpoint can't verify inbound messages from
          Slack.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {bots.map((b) => (
          <SigningSecretRow key={b.id} slug={slug} bot={b} />
        ))}
      </CardContent>
    </Card>
  );
}

function SigningSecretRow({ slug, bot }: { slug: string; bot: SlackBotDTO }) {
  const { recordSigningSecret } = useSlackStore();
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    setSubmitting(true);
    setError(null);
    try {
      await recordSigningSecret(slug, bot.id, secret.trim());
      setSecret("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const slackLink = bot.slack_app_id
    ? `https://api.slack.com/apps/${bot.slack_app_id}/general`
    : "https://api.slack.com/apps";

  return (
    <div className="space-y-2 rounded-md border border-border-soft p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-fg">
          <span className="font-medium">@{bot.bot_name}</span>
          <a
            href={slackLink}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-3 text-xs text-fg-faint underline underline-offset-2"
          >
            Open in Slack
          </a>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          placeholder="Signing secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          className="min-w-[280px] flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          onClick={onSave}
          disabled={submitting || secret.trim().length < 16}
        >
          {submitting ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

function AddBotCard({ slug }: { slug: string }) {
  const { createBot } = useSlackStore();
  const [botName, setBotName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd() {
    setSubmitting(true);
    setError(null);
    try {
      const returnTo = `/workspaces/${slug}/settings/integrations/slack`;
      const result = await createBot(slug, botName.trim(), returnTo);
      window.open(result.manifest_url, "_blank", "noopener,noreferrer");
      setBotName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a Slack bot</CardTitle>
        <CardDescription>
          Pick a handle. Slack opens in a new tab to create the app — make sure
          you select the Slack workspace you want this bot to live in. After
          install, return here and the bot will show its connected Slack
          workspace below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1 space-y-1">
            <Label htmlFor="slack-bot-name">Bot handle</Label>
            <Input
              id="slack-bot-name"
              placeholder="triage"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Button
            onClick={onAdd}
            disabled={submitting || botName.trim().length === 0}
          >
            {submitting ? "Creating…" : "Create bot in Slack"}
          </Button>
        </div>
        {error && <div className="mt-2 text-sm text-danger">{error}</div>}
      </CardContent>
    </Card>
  );
}

function BotsList({
  slug,
  bots,
  canManage,
}: {
  slug: string;
  bots: SlackBotDTO[];
  canManage: boolean;
}) {
  if (bots.length === 0) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-fg-faint">
          No Slack bots yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bots</CardTitle>
        <CardDescription>
          Each bot is its own Slack app. Pair from the agent edit page to
          decide which agent replies when the bot is mentioned.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y divide-border-soft rounded-md border border-border-soft">
          {bots.map((b) => (
            <SlackBotRow key={b.id} slug={slug} bot={b} canManage={canManage} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SlackBotRow({
  slug,
  bot,
  canManage,
}: {
  slug: string;
  bot: SlackBotDTO;
  canManage: boolean;
}) {
  const { deleteBot, unpairBot } = useSlackStore();
  const agentsBySlug = useAgentsStore((s) => s.bySlug);
  const pairedAgent = useMemo(
    () => (agentsBySlug[slug] ?? []).find((a) => a.id === bot.agent_id),
    [agentsBySlug, slug, bot.agent_id],
  );
  const { confirm, dialog } = useConfirm();

  const installed = bot.installs.length > 0;

  async function onDelete() {
    const ok = await confirm({
      title: `Delete @${bot.bot_name}?`,
      description:
        "This removes the bot config from x1agent. The Slack app on Slack's side stays — you'll need to remove it there separately if you want it gone.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    await deleteBot(slug, bot.id);
  }

  async function onUnpair() {
    if (!bot.agent_id) return;
    await unpairBot(slug, bot.id);
  }

  return (
    <>
      {dialog}
      <li className="flex flex-wrap items-start justify-between gap-3 px-3 py-3 text-sm">
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2 text-fg">
          <span className="font-medium">@{bot.bot_name}</span>
          {!installed && (
            <Badge variant="outline" className="text-xs">
              awaiting install
            </Badge>
          )}
          {installed && bot.installs[0]?.slack_team_name && (
            <Badge variant="outline" className="text-xs">
              {bot.installs[0].slack_team_name}
            </Badge>
          )}
          {installed && !bot.has_signing_secret && (
            <Badge variant="warning" className="text-xs">
              needs signing secret
            </Badge>
          )}
        </div>
        <div className="text-xs text-fg-faint">
          {pairedAgent ? (
            <>
              paired with{" "}
              <span className="text-fg-muted">{pairedAgent.name}</span>
            </>
          ) : (
            <>not paired with an agent</>
          )}
        </div>
      </div>
      {canManage && (
        <div className="flex shrink-0 gap-2">
          {bot.agent_id && (
            <Button size="sm" variant="ghost" onClick={onUnpair}>
              Unpair
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onDelete}>
            Delete
          </Button>
        </div>
      )}
      </li>
    </>
  );
}
