import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { EnvironmentsList } from "./EnvironmentsList";

interface Props {
  workspaceSlug: string;
}

/**
 * Workspace-scoped list of durable preview environments. Each row is
 * one slot the agent's `preview_deploy` calls deploy into; the slug is
 * the URL routing key and the row updates in place across deploys.
 */
export function EnvironmentsRoot({ workspaceSlug }: Props) {
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
        { label: "Environments" },
      ]}
    >
      <div className="mx-auto max-w-3xl px-6 pt-8 pb-12">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-fg">
          Environments
        </h1>
        <p className="mb-6 text-sm text-fg-muted">
          Durable preview slots. Each row is one slug an agent has
          deployed to with{" "}
          <code className="rounded bg-bg-elevated px-1 text-xs">
            preview_deploy
          </code>
          . The latest deploy's URL, sha, and image ref are below.
        </p>
        <EnvironmentsList
          workspaceSlug={workspaceSlug}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
