import { useEffect, useMemo, useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { apiFetch } from "../../lib/api";

interface ShareDTO {
  id: string;
  session_id: string;
  user_id: string;
  role: "viewer" | "collaborator";
  shared_by: string;
  created_at: string;
}

interface MemberDTO {
  user_id: string;
  email: string;
  name: string;
  role: string;
}

interface Props {
  workspaceSlug: string;
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Inline panel (no Dialog primitive yet) — recipient + role form to
 * grant access; list of current grants with revoke buttons. Owner-only
 * on backend; the UI surfaces the 403 verbatim if a non-owner clicks.
 *
 * Recipient picker is workspace-scoped: it fetches
 * `/api/workspaces/:slug/members` (the same endpoint AgentEditRoot's
 * "Run as" picker uses) and only ever surfaces members of the active
 * workspace. We never freetext-email a user from another tenant — the
 * server would reject it anyway, but keeping the UI scoped avoids
 * confusing error states.
 */
export function ShareSessionPanel({
  workspaceSlug,
  sessionId,
  open,
  onClose,
}: Props) {
  const [shares, setShares] = useState<ShareDTO[]>([]);
  const [members, setMembers] = useState<MemberDTO[]>([]);
  const [recipientUserId, setRecipientUserId] = useState("");
  const [role, setRole] = useState<"viewer" | "collaborator">("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/workspaces/${workspaceSlug}/sessions/${sessionId}/user-shares`;

  const refresh = async () => {
    setError(null);
    try {
      const r = await apiFetch<{ shares: ShareDTO[] }>(base);
      setShares(r.shares);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Workspace members for the recipient picker. Mirrors the pattern
  // used by AgentEditRoot's "Run as" picker — same endpoint, same
  // graceful-degradation behavior on 403/transient failures (the
  // picker just shows no options and the server-side guard remains
  // the source of truth).
  const refreshMembers = async () => {
    try {
      const r = await apiFetch<{ members: MemberDTO[] }>(
        `/api/workspaces/${workspaceSlug}/members`,
      );
      setMembers(r.members);
    } catch {
      // Non-admins can't read the roster — fall back to an empty
      // picker. The form's submit button stays disabled until a
      // recipient is selected, so this just prevents granting.
      setMembers([]);
    }
  };

  useEffect(() => {
    if (open) {
      void refresh();
      void refreshMembers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, workspaceSlug]);

  // Hide users who already have a grant — re-granting the same user is
  // an idempotent upsert on the server, but surfacing it as a fresh
  // "Share" action confuses people who skim the list. The owner is
  // implicit in the session's triggered_by_user_id and is never a row
  // in the shares table, so they need to be filtered out separately if
  // we ever surface the owner's id here.
  const eligibleMembers = useMemo(() => {
    const granted = new Set(shares.map((s) => s.user_id));
    return members.filter((m) => !granted.has(m.user_id));
  }, [members, shares]);

  if (!open) return null;

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipientUserId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(base, {
        method: "POST",
        body: JSON.stringify({ user_id: recipientUserId, role }),
      });
      setRecipientUserId("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/${userId}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Render member display name with email parenthetical when both
  // exist — same convention as AgentEditRoot's Run-as picker so the
  // list looks consistent across the app.
  const renderMemberLabel = (m: MemberDTO) => {
    const name = m.name?.trim();
    if (name && name !== m.email) return `${name} (${m.email})`;
    return m.email;
  };

  const grantedDisplay = (s: ShareDTO) => {
    const m = members.find((x) => x.user_id === s.user_id);
    if (m) return renderMemberLabel(m);
    return s.user_id.slice(0, 8);
  };

  return (
    <div className="border-b border-border-soft bg-bg/50 px-4 py-3">
      <div className="mx-auto max-w-2xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Share this session</h3>
          <button
            onClick={onClose}
            className="text-xs text-fg-faint hover:text-fg-muted"
          >
            close
          </button>
        </div>
        {/* All three controls (recipient, role, submit) sit in one
            flex row aligned to the bottom of each labeled group, so
            the input + role + button share the same baseline. Using
            `items-end` rather than `items-center` keeps the labels
            stacked above their controls without offsetting the
            button (which has no label). */}
        <form onSubmit={grant} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1 space-y-1">
            <Label htmlFor="share-recipient" className="text-xs text-fg-muted">
              Recipient
            </Label>
            <Select
              value={recipientUserId}
              onValueChange={setRecipientUserId}
              disabled={busy || eligibleMembers.length === 0}
            >
              <SelectTrigger id="share-recipient">
                <SelectValue
                  placeholder={
                    eligibleMembers.length === 0
                      ? "No workspace members to share with"
                      : "Choose a workspace member"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {eligibleMembers.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {renderMemberLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="share-role" className="text-xs text-fg-muted">
              Role
            </Label>
            <Select
              value={role}
              onValueChange={(v) =>
                setRole(v as "viewer" | "collaborator")
              }
            >
              <SelectTrigger id="share-role" className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer</SelectItem>
                <SelectItem value="collaborator">Collaborator</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {/* `size="default"` matches the h-9 of Input/SelectTrigger
              so the button sits flush with the recipient + role
              controls instead of riding 4px high on `size="sm"`. */}
          <Button
            type="submit"
            size="default"
            disabled={busy || !recipientUserId}
          >
            <UserPlus className="size-3.5" />
            <span className="ml-1">Share</span>
          </Button>
        </form>

        {error && (
          <div
            role="alert"
            className="rounded border border-red-900/50 bg-red-950/30 px-2 py-1 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-900"
          >
            {error}
          </div>
        )}

        {shares.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wider text-fg-faint">
              Current grants
            </div>
            <ul className="divide-y divide-border-soft rounded border border-border-soft">
              {shares.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-fg" title={grantedDisplay(s)}>
                      {grantedDisplay(s)}
                    </span>
                    <span className="text-fg-faint">·</span>
                    <span className="capitalize text-fg-muted">{s.role}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(s.user_id)}
                    disabled={busy}
                    className="text-fg-faint hover:text-red-500 disabled:opacity-50"
                    title="Revoke"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
