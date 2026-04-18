import { useEffect, useState } from "react";
import type { Role } from "@x1agent/shared";
import { useInvitationsStore } from "../../stores/invitationsStore";

interface Props {
  slug: string;
  /** Only admins/owners can manage invitations. */
  canManage: boolean;
}

export function InvitationsPanel({ slug, canManage }: Props) {
  const { bySlug, loadingSlug, errorBySlug, load, create, revoke } =
    useInvitationsStore();
  const rows = bySlug[slug] ?? [];
  const error = errorBySlug[slug];

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (canManage) load(slug);
  }, [slug, canManage, load]);

  if (!canManage) return null;

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await create(slug, email.trim(), role);
      setEmail("");
      setRole("member");
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-zinc-800 p-4 space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500">
          Invitations
        </div>
        <p className="text-sm text-zinc-400">
          Invite a Google account to this workspace. They'll sign in and
          accept before gaining access.
        </p>
      </div>

      <form onSubmit={onInvite} className="flex gap-2 items-end flex-wrap">
        <label className="flex flex-col text-xs text-zinc-400 flex-1 min-w-56">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            className="mt-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
          />
        </label>
        <label className="flex flex-col text-xs text-zinc-400">
          Role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="mt-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={submitting || !email}
          className="rounded-md bg-white px-4 py-1.5 text-sm font-medium text-black hover:bg-zinc-200 disabled:opacity-50"
        >
          {submitting ? "Sending…" : "Send invite"}
        </button>
      </form>
      {submitError && (
        <div className="text-sm text-red-400">{submitError}</div>
      )}

      {loadingSlug === slug && (
        <div className="text-sm text-zinc-400">Loading invitations…</div>
      )}
      {error && <div className="text-sm text-red-400">{error}</div>}

      {rows.length === 0 && loadingSlug !== slug && (
        <div className="text-sm text-zinc-500">No invitations yet.</div>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded-md">
          {rows.map((inv) => {
            const state = inv.accepted_at
              ? "accepted"
              : inv.revoked_at
                ? "revoked"
                : new Date(inv.expires_at).getTime() < Date.now()
                  ? "expired"
                  : "pending";
            const canRevoke = state === "pending";
            return (
              <li
                key={inv.id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div>
                  <div className="text-zinc-100">{inv.email}</div>
                  <div className="text-xs text-zinc-500">
                    {inv.role} · {state}
                  </div>
                </div>
                {canRevoke && (
                  <button
                    type="button"
                    onClick={() => revoke(slug, inv.id)}
                    className="text-xs text-zinc-400 hover:text-red-400"
                  >
                    revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
