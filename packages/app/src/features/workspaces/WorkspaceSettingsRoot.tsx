import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { InvitationsPanel } from "../invitations/InvitationsPanel";

interface Props {
  workspaceSlug: string;
}

export function WorkspaceSettingsRoot({ workspaceSlug }: Props) {
  const { status, memberships, fetchMe } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === "anonymous" && typeof window !== "undefined") {
      window.location.href = "/";
    }
  }, [status]);

  const ws = memberships.find((m) => m.slug === workspaceSlug);
  const canManage = ws?.role === "admin" || ws?.role === "owner";

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "Settings" },
      ]}
    >
      <div className="space-y-6 p-6">
        <div className="max-w-3xl space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Workspace</CardTitle>
              <CardDescription>
                Identity and role in this workspace.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Name" value={ws?.name ?? workspaceSlug} />
              <Row label="Slug" value={workspaceSlug} mono />
              <Row
                label="Your role"
                value={ws ? <Badge variant="secondary">{ws.role}</Badge> : "—"}
              />
            </CardContent>
          </Card>

          <InvitationsPanel slug={workspaceSlug} canManage={!!canManage} />

          {!canManage && (
            <Card>
              <CardContent className="py-4 text-sm text-zinc-500">
                Only workspace admins and owners can manage invitations.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={mono ? "font-mono text-zinc-200" : "text-zinc-200"}>
        {value}
      </div>
    </div>
  );
}
