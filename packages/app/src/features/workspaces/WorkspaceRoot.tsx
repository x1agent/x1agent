import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAuthStore } from "../../stores/authStore";
import { AgentsPanel } from "../agents/AgentsPanel";
import { TokenUsagePanel } from "./TokenUsagePanel";

interface Props {
  slug: string;
}

export function WorkspaceRoot({ slug }: Props) {
  const { user, memberships, status, fetchMe } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  if (status === "loading" || status === "idle") {
    return (
      <AppShell>
        <div className="p-8 text-sm text-zinc-400">Loading…</div>
      </AppShell>
    );
  }
  if (status === "anonymous") {
    if (typeof window !== "undefined") window.location.href = "/";
    return null;
  }

  const ws = memberships.find((m) => m.slug === slug);
  if (!ws) {
    return (
      <AppShell>
        <div className="p-8 space-y-2">
          <h1 className="text-xl font-semibold">Workspace not found</h1>
          <p className="text-sm text-zinc-400">
            You are not a member of <code>{slug}</code>.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="p-8 space-y-6 max-w-3xl">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Workspace
          </div>
          <h1 className="text-2xl font-semibold">{ws.name}</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Signed in as</CardTitle>
            <CardDescription>{user?.email}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-zinc-400">
            role: {ws.role}
          </CardContent>
        </Card>

        <AgentsPanel
          workspaceSlug={slug}
          canManage={ws.role === "admin" || ws.role === "owner"}
        />

        <TokenUsagePanel
          workspaceSlug={slug}
          canManage={ws.role === "admin" || ws.role === "owner"}
        />

        <Card>
          <CardHeader>
            <CardTitle>Your workspaces</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {memberships.map((m) => (
              <a
                key={m.workspace_id}
                href={`/workspaces/${m.slug}`}
                className={
                  m.slug === slug
                    ? "block text-white"
                    : "block text-zinc-400 hover:text-white"
                }
              >
                {m.name}
              </a>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
