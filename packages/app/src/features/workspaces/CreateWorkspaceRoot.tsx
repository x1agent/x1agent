import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceCreateStore } from "../../stores/workspaceCreateStore";

/**
 * Form for creating the first workspace. Mounted at /workspaces/new.
 *
 * Gated to platform admins (email in PLATFORM_ADMIN_EMAILS) — non-admins
 * shouldn't see this even if they navigate directly. The api also
 * enforces the same gate; UI gate is for affordance, not security.
 *
 * Form draft state (name / slug / slugDirty / submitting / error) lives
 * in `useWorkspaceCreateStore` per CLAUDE.md "Frontend state management"
 * — the slug auto-tracks the name until the user edits it manually.
 */
export function CreateWorkspaceRoot() {
  const { isPlatformAdmin, status, fetchMe } = useAuthStore();
  // Atomic selectors — one per primitive — return referentially stable
  // values across renders and avoid the `selector returns a fresh object
  // each render → React error #185` foot-gun called out in CLAUDE.md.
  const name = useWorkspaceCreateStore((s) => s.name);
  const slug = useWorkspaceCreateStore((s) => s.slug);
  const submitting = useWorkspaceCreateStore((s) => s.submitting);
  const error = useWorkspaceCreateStore((s) => s.error);
  const setName = useWorkspaceCreateStore((s) => s.setName);
  const setSlug = useWorkspaceCreateStore((s) => s.setSlug);
  const reset = useWorkspaceCreateStore((s) => s.reset);
  const submit = useWorkspaceCreateStore((s) => s.submit);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  // Reset the draft when the form mounts so a previous attempt's name /
  // slug / error don't leak into a fresh visit.
  useEffect(() => {
    reset();
  }, [reset]);

  const slugInvalid =
    slug.length > 0 && !/^[a-z][a-z0-9-]{1,31}$/.test(slug);
  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    /^[a-z][a-z0-9-]{1,31}$/.test(slug);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const ws = await submit();
    if (ws) {
      window.location.href = `/workspaces/${ws.slug}`;
    }
  }

  if (status === "loading" || status === "idle") {
    return (
      <AppShell chrome={false}>
        <div className="p-8 text-sm text-fg-muted">Loading…</div>
      </AppShell>
    );
  }
  if (status === "anonymous") {
    if (typeof window !== "undefined") window.location.href = "/";
    return null;
  }
  if (!isPlatformAdmin) {
    return (
      <AppShell chrome={false}>
        <div className="p-8 max-w-md space-y-2">
          <h1 className="text-xl font-semibold">Not authorized</h1>
          <p className="text-sm text-fg-muted">
            Only platform admins can create workspaces. Ask one to invite you
            to an existing workspace instead.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell chrome={false}>
      <div className="flex min-h-screen items-center justify-center px-6">
        <form onSubmit={onSubmit} className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="text-xl font-semibold">Create a workspace</h1>
            <p className="text-sm text-fg-muted">
              You can invite other members after this is created.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ws-name">Workspace name</Label>
            <Input
              id="ws-name"
              placeholder="Acme Engineering"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ws-slug">URL slug</Label>
            <Input
              id="ws-slug"
              placeholder="acme"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
              aria-invalid={slugInvalid}
            />
            <p className="text-xs text-fg-faint">
              Lowercase letters, digits, hyphens. 2–32 chars, starts with a
              letter. Lives at <code>/workspaces/{slug || "<slug>"}</code>.
            </p>
            {slugInvalid && (
              <p className="text-xs text-red-400">
                Slug must match: lowercase letters, digits, hyphens only.
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <Button type="submit" disabled={!canSubmit} className="w-full">
            {submitting ? "Creating…" : "Create workspace"}
          </Button>
        </form>
      </div>
    </AppShell>
  );
}
