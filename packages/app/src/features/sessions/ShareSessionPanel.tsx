import { useEffect, useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
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

interface Props {
  workspaceSlug: string;
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Inline panel (no Dialog primitive yet) — email + role form to grant
 * access; list of current grants with revoke buttons. Owner-only on
 * backend; the UI surfaces the 403 verbatim if a non-owner clicks.
 */
export function ShareSessionPanel({
  workspaceSlug,
  sessionId,
  open,
  onClose,
}: Props) {
  const [shares, setShares] = useState<ShareDTO[]>([]);
  const [email, setEmail] = useState("");
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

  useEffect(() => {
    if (open) void refresh();
  }, [open, sessionId, workspaceSlug]);

  if (!open) return null;

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(base, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      setEmail("");
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

  return (
    <div className="border-b border-zinc-900 bg-zinc-950/50 px-4 py-3">
      <div className="mx-auto max-w-2xl space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Share this session</h3>
          <button
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            close
          </button>
        </div>
        <form onSubmit={grant} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px] space-y-1">
            <Label htmlFor="share-email" className="text-xs text-zinc-400">
              Email
            </Label>
            <Input
              id="share-email"
              type="email"
              placeholder="user@x1agent.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="share-role" className="text-xs text-zinc-400">
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
          <Button type="submit" size="sm" disabled={busy}>
            <UserPlus className="size-3.5" />
            <span className="ml-1">Share</span>
          </Button>
        </form>

        {error && (
          <div className="rounded border border-red-900/50 bg-red-950/30 px-2 py-1 text-xs text-red-300">
            {error}
          </div>
        )}

        {shares.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wider text-zinc-500">
              Current grants
            </div>
            <ul className="divide-y divide-zinc-900 rounded border border-zinc-900">
              {shares.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-zinc-400">
                      {s.user_id.slice(0, 8)}
                    </span>
                    <span className="ml-2 text-zinc-500">·</span>
                    <span className="ml-2 capitalize text-zinc-300">
                      {s.role}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(s.user_id)}
                    disabled={busy}
                    className="text-zinc-500 hover:text-red-400 disabled:opacity-50"
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
