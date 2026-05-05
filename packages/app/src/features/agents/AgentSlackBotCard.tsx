import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useSlackStore, type SlackBotDTO } from "../../stores/slackStore";

interface Props {
  workspaceSlug: string;
  agentId: string;
  canManage: boolean;
}

const NONE_VALUE = "__none__";

/**
 * Pair a Slack bot with this agent. The picker offers:
 *   - The bot currently paired with this agent (if any), preselected.
 *   - Every workspace bot whose `agent_id` is null (i.e. not taken).
 * Bots already paired with a different agent are deliberately excluded
 * — re-pairing has to happen from the other agent first, which keeps
 * the action visible to whoever owns that bot today.
 */
export function AgentSlackBotCard({ workspaceSlug, agentId, canManage }: Props) {
  const { configuredByWorkspace, botsByWorkspace, load, pairBot, unpairBot } =
    useSlackStore();
  const configured = configuredByWorkspace[workspaceSlug];
  const bots = botsByWorkspace[workspaceSlug] ?? [];

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  const paired = useMemo(
    () => bots.find((b) => b.agent_id === agentId),
    [bots, agentId],
  );
  const available = useMemo<SlackBotDTO[]>(
    () => bots.filter((b) => b.agent_id === null || b.id === paired?.id),
    [bots, paired],
  );

  const [selected, setSelected] = useState<string>(paired?.id ?? NONE_VALUE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the local selection when the store updates beneath us.
  useEffect(() => {
    setSelected(paired?.id ?? NONE_VALUE);
  }, [paired?.id]);

  const dirty = selected !== (paired?.id ?? NONE_VALUE);

  async function onSave() {
    setSubmitting(true);
    setError(null);
    try {
      if (selected === NONE_VALUE) {
        if (paired) await unpairBot(workspaceSlug, paired.id);
      } else if (selected !== paired?.id) {
        if (paired) await unpairBot(workspaceSlug, paired.id);
        await pairBot(workspaceSlug, selected, agentId);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (configured === false) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Slack bot</CardTitle>
          <CardDescription>
            Slack is not configured on this server. Ask the workspace admin to
            register the platform Slack app under workspace settings →
            integrations → Slack.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack bot</CardTitle>
        <CardDescription>
          Pair this agent with one of the workspace's Slack bots. When the
          bot is mentioned in Slack, this agent replies. Configure or add
          bots under{" "}
          <a
            href={`/workspaces/${workspaceSlug}/settings/integrations/slack`}
            className="underline underline-offset-2"
          >
            workspace settings → integrations → Slack
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {bots.length === 0 ? (
          <div className="text-sm text-fg-faint">
            No Slack bots in this workspace yet.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={selected}
              onValueChange={setSelected}
              disabled={!canManage || submitting}
            >
              <SelectTrigger className="w-[260px]">
                <SelectValue placeholder="Choose a Slack bot…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>Not paired</SelectItem>
                {available.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    @{b.bot_name}
                    {b.installs[0]?.slack_team_name
                      ? ` · ${b.installs[0].slack_team_name}`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManage && dirty && (
              <Button onClick={onSave} disabled={submitting} type="button">
                {submitting ? "Saving…" : "Save"}
              </Button>
            )}
            {paired && !dirty && (
              <Badge variant="outline" className="text-xs">
                paired
              </Badge>
            )}
          </div>
        )}
        {error && <div className="text-sm text-danger">{error}</div>}
      </CardContent>
    </Card>
  );
}
