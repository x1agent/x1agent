import { useEffect, useState } from "react";
import {
  useAccessGrantsStore,
  type AccessGrantKind,
  type AccessGrantRole,
} from "../../stores/accessGrantsStore";

interface Props {
  slug: string;
  canManage: boolean;
}

const EMPTY: ReturnType<typeof useAccessGrantsStore.getState>["byWorkspace"][string] = [];

export function AccessGrantsPanel({ slug, canManage }: Props) {
  const grants = useAccessGrantsStore((s) => s.byWorkspace[slug] ?? EMPTY);
  const status = useAccessGrantsStore((s) => s.status[slug] ?? "idle");
  const error = useAccessGrantsStore((s) => s.error[slug] ?? null);
  const load = useAccessGrantsStore((s) => s.loadForWorkspace);
  const add = useAccessGrantsStore((s) => s.add);
  const remove = useAccessGrantsStore((s) => s.remove);

  const [kind, setKind] = useState<AccessGrantKind>("domain");
  const [value, setValue] = useState("");
  const [defaultRole, setDefaultRole] = useState<AccessGrantRole>("member");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") load(slug);
  }, [status, slug, load]);

  if (status === "loading" || status === "idle") {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }
  if (status === "error") {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await add(slug, {
        kind,
        value: value.trim(),
        default_role: defaultRole,
      });
      setValue("");
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-fg">Access grants</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Anyone whose email matches one of these can sign in straight into this workspace —
          no per-person invitation needed. Domain grants cover everyone at that company; email
          grants are exact-match. Domain allowlist (
          <code className="rounded bg-bg-elevated px-1 text-xs">ALLOWED_DOMAINS</code>) is still
          enforced for everyone else.
        </p>
      </div>

      {canManage && (
        <form onSubmit={onAdd} className="rounded-lg border border-border-soft bg-bg-elevated/30 p-4 space-y-3">
          <h3 className="text-sm font-medium text-fg">Add grant</h3>
          <div className="grid gap-3 sm:grid-cols-[140px_1fr_140px_auto]">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as AccessGrantKind)}
              className="rounded-md border border-border-soft bg-bg-elevated px-3 py-2 text-sm text-fg"
            >
              <option value="domain">Domain</option>
              <option value="email">Email</option>
            </select>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === "domain" ? "foocorp.com" : "someone@foocorp.com"}
              autoComplete="off"
              className="rounded-md border border-border-soft bg-bg-elevated px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            />
            <select
              value={defaultRole}
              onChange={(e) => setDefaultRole(e.target.value as AccessGrantRole)}
              className="rounded-md border border-border-soft bg-bg-elevated px-3 py-2 text-sm text-fg"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="submit"
              disabled={submitting || !value.trim()}
              className="rounded-md bg-fg px-3 py-2 text-sm font-medium text-bg hover:bg-fg/90 disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add"}
            </button>
          </div>
          {formError && (
            <p className="text-sm text-red-300">{formError}</p>
          )}
        </form>
      )}

      {grants.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-soft p-6 text-sm text-fg-muted">
          No access grants yet. Add a domain like{" "}
          <code className="rounded bg-bg-elevated px-1">foocorp.com</code> or an email like{" "}
          <code className="rounded bg-bg-elevated px-1">someone@foocorp.com</code> to let them
          sign in straight into this workspace.
        </div>
      ) : (
        <ul className="space-y-2">
          {grants.map((g) => (
            <li
              key={g.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border-soft bg-bg-elevated/30 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full bg-bg-elevated px-2 py-0.5 text-xs font-medium text-fg-muted">
                    {g.kind}
                  </span>
                  <span className="truncate font-medium text-fg">{g.value}</span>
                  {g.default_role && (
                    <span className="text-xs text-fg-muted">→ {g.default_role}</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-fg-muted">
                  added {new Date(g.created_at).toLocaleDateString()}
                  {g.expires_at && ` · expires ${new Date(g.expires_at).toLocaleDateString()}`}
                </div>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => remove(slug, g.id)}
                  className="shrink-0 text-sm text-red-300 hover:text-red-200"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
