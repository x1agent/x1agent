import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import { useAuthStore } from "../../stores/authStore";

/**
 * Shown when an authenticated user has zero workspace memberships.
 *
 * Two branches:
 *   - Platform admin (email in PLATFORM_ADMIN_EMAILS): show a
 *     "Create your first workspace" CTA → /workspaces/new. Bootstrap
 *     path for fresh installs — without it, the very first admin to
 *     sign in has no UI affordance and is stuck contacting themselves.
 *   - Anyone else: keep the dead-end "contact an administrator" copy.
 */
export function NoAccessRoot() {
  const { isPlatformAdmin, status, fetchMe } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  if (status === "loading" || status === "idle") {
    return (
      <AppShell chrome={false}>
        <div className="flex min-h-screen items-center justify-center px-6">
          <div className="text-sm text-zinc-400">Loading…</div>
        </div>
      </AppShell>
    );
  }

  if (isPlatformAdmin) {
    return (
      <AppShell chrome={false}>
        <div className="flex min-h-screen items-center justify-center px-6">
          <div className="w-full max-w-sm space-y-4 text-center">
            <h1 className="text-xl font-semibold">Welcome to x1agent</h1>
            <p className="text-sm text-zinc-400">
              You're signed in as a platform admin but no workspace exists
              yet. Create one to get started.
            </p>
            <Button asChild>
              <a href="/workspaces/new">Create your first workspace</a>
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell chrome={false}>
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-semibold">No workspace access</h1>
          <p className="text-sm text-zinc-400">
            Your Google account is not a member of any workspace. Contact an
            administrator to get access.
          </p>
          <Button variant="link" asChild>
            <a href="/">Back to sign in</a>
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
