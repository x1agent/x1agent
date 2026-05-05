import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { AgentsPanel } from "./AgentsPanel";

interface Props {
  workspaceSlug: string;
}

/**
 * Standalone agents list page at /workspaces/<slug>/agents/.
 * Was previously folded into the workspace home, but the home is now
 * the driver landing (composer + recent conversations) — agents needed
 * their own surface to be discoverable + manageable.
 */
export function AgentsRoot({ workspaceSlug }: Props) {
  const { memberships, status, fetchMe } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  if (status === "loading" || status === "idle") {
    return (
      <AppShell>
        <div className="p-8 text-sm text-fg-muted">Loading…</div>
      </AppShell>
    );
  }
  if (status === "anonymous") {
    if (typeof window !== "undefined") window.location.href = "/";
    return null;
  }

  const ws = memberships.find((m) => m.slug === workspaceSlug);
  if (!ws) {
    return (
      <AppShell>
        <div className="space-y-2 p-8">
          <h1 className="text-xl font-semibold">Workspace not found</h1>
        </div>
      </AppShell>
    );
  }

  const canManage = ws.role === "admin" || ws.role === "owner";

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}/` },
        { label: "Agents" },
      ]}
    >
      <div className="mx-auto max-w-3xl px-6 pt-8 pb-12">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-fg">
          Agents
        </h1>
        <AgentsPanel
          workspaceSlug={workspaceSlug}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
