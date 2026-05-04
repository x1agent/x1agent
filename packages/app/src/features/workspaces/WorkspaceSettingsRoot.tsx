import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { useUrlSearchParam } from "../../lib/useUrlSearchParam";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";
import { InvitationsPanel } from "../invitations/InvitationsPanel";
import { SharedAgentResourcesPanel } from "./SharedAgentResourcesPanel";
import { ContainerRegistryPanel } from "./ContainerRegistryPanel";
import { WorkspaceSecretsPanel } from "./WorkspaceSecretsPanel";
import { WorkspaceMcpCatalogPanel } from "./WorkspaceMcpCatalogPanel";
import { AnalyticsRoot } from "../analytics/AnalyticsRoot";

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

  // URL-synced active tab. Default "resources" stays clean in the URL;
  // selecting another tab writes `?tab=registry` / `?tab=invitations`.
  const [tab, setTab] = useUrlSearchParam("tab", "resources");

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        { label: "Settings" },
      ]}
    >
      <div className="space-y-6 p-6">
        <div className="max-w-4xl space-y-6">
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

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="resources">Shared resources</TabsTrigger>
              <TabsTrigger value="registry">Container registry</TabsTrigger>
              <TabsTrigger value="secrets">Environment variables</TabsTrigger>
              <TabsTrigger value="mcp">MCP servers</TabsTrigger>
              <TabsTrigger value="invitations">Invitations</TabsTrigger>
              <TabsTrigger value="analytics">Analytics</TabsTrigger>
            </TabsList>

            <TabsContent value="resources">
              <SharedAgentResourcesPanel
                slug={workspaceSlug}
                canManage={!!canManage}
              />
              {!canManage && (
                <Card className="mt-4">
                  <CardContent className="py-4 text-sm text-zinc-500">
                    Only workspace admins and owners can install or remove
                    shared agent resources.
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="registry">
              <ContainerRegistryPanel slug={workspaceSlug} />
            </TabsContent>

            <TabsContent value="secrets">
              <WorkspaceSecretsPanel
                slug={workspaceSlug}
                canManage={!!canManage}
              />
            </TabsContent>

            <TabsContent value="mcp">
              <WorkspaceMcpCatalogPanel
                slug={workspaceSlug}
                canManage={!!canManage}
              />
            </TabsContent>

            <TabsContent value="invitations">
              <InvitationsPanel slug={workspaceSlug} canManage={!!canManage} />
              {!canManage && (
                <Card className="mt-4">
                  <CardContent className="py-4 text-sm text-zinc-500">
                    Only workspace admins and owners can manage invitations.
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="analytics">
              <AnalyticsRoot
                workspaceSlug={workspaceSlug}
                canManage={!!canManage}
              />
            </TabsContent>
          </Tabs>
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
