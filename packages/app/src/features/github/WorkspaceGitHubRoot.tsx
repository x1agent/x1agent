import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { GitHubInstallationsCard } from "./GitHubInstallationsCard";

interface Props {
  workspaceSlug: string;
}

export function WorkspaceGitHubRoot({ workspaceSlug }: Props) {
  const { status, fetchMe } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === "anonymous" && typeof window !== "undefined") {
      window.location.href = "/";
    }
  }, [status]);

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "GitHub" },
      ]}
    >
      <div className="space-y-6 p-6">
        <div className="max-w-3xl">
          <GitHubInstallationsCard />
        </div>
      </div>
    </AppShell>
  );
}
