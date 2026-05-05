import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useAgentsStore } from "../../stores/agentsStore";
import { useGrantsStore } from "../../stores/grantsStore";

interface Props {
  workspaceSlug: string;
  /** The agent that will hold the spawn grants (the parent / orchestrator). */
  parentAgentId: string;
  parentAgentName: string;
  canManage: boolean;
}

/**
 * "Which child agents can this agent spawn?" Renders one row per
 * persistent spawn grant held by the parent. Admins can attach
 * another child or revoke an existing grant; non-admins see the list
 * read-only.
 */
export function CanSpawnCard({
  workspaceSlug,
  parentAgentId,
  parentAgentName,
  canManage,
}: Props) {
  const { bySlug, load } = useAgentsStore();
  const {
    spawnByAgent,
    loadingKey,
    errorKey,
    error,
    loadSpawnGrants,
    createGrant,
    revokeGrant,
  } = useGrantsStore();

  const [selectedChild, setSelectedChild] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const key = `${workspaceSlug}:${parentAgentId}`;
  const grants = spawnByAgent[key] ?? [];
  const agents = bySlug[workspaceSlug] ?? [];

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  useEffect(() => {
    loadSpawnGrants(workspaceSlug, parentAgentId);
  }, [workspaceSlug, parentAgentId, loadSpawnGrants]);

  const currentChildIds = useMemo(
    () =>
      new Set(
        grants
          .map((g) => g.details["child_agent_id"])
          .filter((v): v is string => typeof v === "string"),
      ),
    [grants],
  );

  const candidates = useMemo(
    () =>
      agents.filter(
        (a) => a.id !== parentAgentId && !currentChildIds.has(a.id),
      ),
    [agents, parentAgentId, currentChildIds],
  );

  const agentById = useMemo(() => {
    const m = new Map<string, { name: string; slug: string }>();
    for (const a of agents) m.set(a.id, { name: a.name, slug: a.slug });
    return m;
  }, [agents]);

  const onAdd = async () => {
    if (!selectedChild) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await createGrant(workspaceSlug, {
        agent_subject_id: parentAgentId,
        grant_type: "spawn",
        details: { child_agent_id: selectedChild },
        scope: "persistent",
        reason: `granted by admin on agent edit screen`,
      });
      setSelectedChild("");
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Can spawn</CardTitle>
        <CardDescription>
          Child agents that <span className="text-fg">{parentAgentName}</span>{" "}
          is allowed to spawn. Persistent grants only — revoke
          individually below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={selectedChild}
              onValueChange={setSelectedChild}
              disabled={candidates.length === 0}
            >
              <SelectTrigger className="w-[260px]">
                <SelectValue
                  placeholder={
                    candidates.length === 0
                      ? "No other agents available"
                      : "Choose child agent…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              onClick={onAdd}
              disabled={!selectedChild || submitting}
            >
              {submitting ? "Granting…" : "Grant"}
            </Button>
            {submitError && (
              <span className="text-xs text-red-400">{submitError}</span>
            )}
          </div>
        )}

        {errorKey === key && error && (
          <div className="text-sm text-red-400">{error}</div>
        )}

        {loadingKey === key && grants.length === 0 && (
          <div className="text-sm text-fg-faint">Loading grants…</div>
        )}

        {grants.length === 0 && loadingKey !== key && (
          <div className="rounded-md border border-border-soft p-6 text-center text-sm text-fg-faint">
            No spawn permissions yet.
          </div>
        )}

        {grants.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border-soft">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Child agent</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Granted</TableHead>
                  {canManage && <TableHead className="w-0" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((g) => {
                  const childId = g.details["child_agent_id"] as
                    | string
                    | undefined;
                  const child = childId ? agentById.get(childId) : undefined;
                  return (
                    <TableRow key={g.id} className="hover:bg-transparent">
                      <TableCell>
                        {child ? (
                          <a
                            className="text-fg hover:underline"
                            href={`/workspaces/${workspaceSlug}/agents/${child.slug}`}
                          >
                            {child.name}
                          </a>
                        ) : (
                          <span className="font-mono text-xs text-fg-faint">
                            {childId ?? "—"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{g.scope}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-fg-faint">
                        {new Date(g.granted_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => revokeGrant(workspaceSlug, g.id)}
                            className="text-fg-muted hover:text-red-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
