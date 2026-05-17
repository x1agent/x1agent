import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
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
import { apiFetch } from "../../lib/api";
import { useWorkspaceMembersStore } from "../../stores/workspaceMembersStore";

type Visibility = "private" | "workspace" | "via_grants";

interface Grant {
  id: string;
  agent_id: string;
  subject_kind: "user" | "group" | "workspace" | "public";
  subject_id: string | null;
  verb: "view" | "invoke" | "collaborate" | "edit";
  granted_by: string;
  created_at: string;
}

interface Props {
  workspaceSlug: string;
  agentId: string;
  agentName: string;
  visibility: Visibility;
  canManage: boolean;
  /** Called after a successful visibility flip so the parent can refetch. */
  onVisibilityChanged?: (next: Visibility) => void;
}

/**
 * Access control surface on the Permissions tab.
 *
 *   Default — Open. Visibility = `workspace`. Every workspace member
 *   can chat in every session of this agent. No explicit grants
 *   needed. Resumes inherit automatically.
 *
 *   Restricted. Visibility = `private`. Only the agent owner +
 *   collaborators listed below can chat. Pick people explicitly.
 *
 * Decoupled from session-share grants on purpose. The session-share
 * modal stays scoped to a single session id — adding someone there
 * grants per-session access only. Adding someone HERE grants access
 * to every past + future session this agent runs. The two systems
 * don't write to each other and one doesn't supersede the other:
 * they're additive ways to grant access.
 */
export function AgentCollaboratorsCard({
  workspaceSlug,
  agentId,
  agentName,
  visibility,
  canManage,
  onVisibilityChanged,
}: Props) {
  const { bySlug, load: loadMembers } = useWorkspaceMembersStore();
  const members = bySlug[workspaceSlug] ?? [];

  const [grants, setGrants] = useState<Grant[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flipping, setFlipping] = useState(false);

  useEffect(() => {
    loadMembers(workspaceSlug);
  }, [workspaceSlug, loadMembers]);

  const reload = async () => {
    try {
      const r = await apiFetch<{ grants: Grant[] }>(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/grants`,
      );
      setGrants(r.grants);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, agentId]);

  const isOpen = visibility === "workspace";

  const collaborators = useMemo(
    () =>
      grants.filter(
        (g) => g.verb === "collaborate" && g.subject_kind === "user",
      ),
    [grants],
  );

  const memberByUserId = useMemo(() => {
    const m = new Map<string, { email: string; name: string }>();
    for (const x of members) m.set(x.user_id, { email: x.email, name: x.name });
    return m;
  }, [members]);

  const candidates = useMemo(() => {
    const taken = new Set(
      collaborators
        .map((g) => g.subject_id)
        .filter((v): v is string => v !== null),
    );
    return members.filter((m) => !taken.has(m.user_id));
  }, [members, collaborators]);

  const flipVisibility = async (next: Visibility) => {
    setFlipping(true);
    setSubmitError(null);
    try {
      await apiFetch(`/api/workspaces/${workspaceSlug}/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      onVisibilityChanged?.(next);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setFlipping(false);
    }
  };

  const onAdd = async () => {
    const e = selectedEmail.trim();
    if (!e) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiFetch(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/grants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject_kind: "user",
            email: e,
            verb: "collaborate",
          }),
        },
      );
      setSelectedEmail("");
      await reload();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const onRevoke = async (grantId: string) => {
    setBusyId(grantId);
    try {
      await apiFetch(
        `/api/workspaces/${workspaceSlug}/agents/${agentId}/grants/${grantId}`,
        { method: "DELETE" },
      );
      await reload();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Who can chat with this agent</CardTitle>
        <CardDescription>
          Access applies to every session{" "}
          <span className="text-fg">{agentName}</span> runs — including
          sessions resumed in the future. Distinct from per-session sharing,
          which is configured on each session's Share button.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-3" disabled={!canManage || flipping}>
          <legend className="sr-only">Visibility</legend>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border-soft p-3 hover:bg-surface-elevated">
            <input
              type="radio"
              name={`visibility-${agentId}`}
              checked={isOpen}
              onChange={() => void flipVisibility("workspace")}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-fg">
                Open to all workspace members
              </div>
              <div className="text-xs text-fg-muted">
                Every member of this workspace can chat. New members get
                access automatically.
              </div>
            </div>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border-soft p-3 hover:bg-surface-elevated">
            <input
              type="radio"
              name={`visibility-${agentId}`}
              checked={!isOpen}
              onChange={() => void flipVisibility("private")}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-fg">
                Restricted to specific people
              </div>
              <div className="text-xs text-fg-muted">
                Only the owner and people listed below can chat.
              </div>
            </div>
          </label>
        </fieldset>

        {submitError && (
          <div className="text-sm text-red-400">{submitError}</div>
        )}

        {!isOpen && (
          <>
            <div className="border-t border-border-soft pt-4">
              <h3 className="text-sm font-medium text-fg">Collaborators</h3>
              <p className="mt-1 text-xs text-fg-muted">
                Add workspace members one at a time. Group support comes
                later — for now, list each person.
              </p>
            </div>

            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                {candidates.length > 0 ? (
                  <Select
                    value={selectedEmail}
                    onValueChange={setSelectedEmail}
                    disabled={submitting}
                  >
                    <SelectTrigger className="w-[260px]">
                      <SelectValue placeholder="Choose workspace member…" />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((m) => (
                        <SelectItem key={m.user_id} value={m.email}>
                          {m.name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type="email"
                    placeholder="email@example.com"
                    value={selectedEmail}
                    onChange={(e) => setSelectedEmail(e.target.value)}
                    disabled={submitting}
                    className="w-[260px]"
                  />
                )}
                <Button
                  type="button"
                  onClick={onAdd}
                  disabled={submitting || selectedEmail.trim().length === 0}
                >
                  {submitting ? "Adding…" : "Add"}
                </Button>
              </div>
            )}

            {loadError && (
              <div className="text-sm text-red-400">{loadError}</div>
            )}

            {collaborators.length === 0 ? (
              <div className="rounded-md border border-border-soft p-6 text-center text-sm text-fg-faint">
                No collaborators yet. Only the agent owner has access.
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border border-border-soft">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>User</TableHead>
                      <TableHead>Granted</TableHead>
                      {canManage && <TableHead className="w-0" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {collaborators.map((g) => {
                      const sub = g.subject_id
                        ? memberByUserId.get(g.subject_id)
                        : null;
                      return (
                        <TableRow key={g.id} className="hover:bg-transparent">
                          <TableCell>
                            {sub ? (
                              <div className="flex flex-col">
                                <span className="text-fg">
                                  {sub.name || sub.email}
                                </span>
                                {sub.name && (
                                  <span className="text-xs text-fg-faint">
                                    {sub.email}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="font-mono text-xs text-fg-faint">
                                {g.subject_id ?? "—"}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-fg-faint">
                            {new Date(g.created_at).toLocaleString(undefined, {
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
                                disabled={busyId === g.id}
                                onClick={() => void onRevoke(g.id)}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
