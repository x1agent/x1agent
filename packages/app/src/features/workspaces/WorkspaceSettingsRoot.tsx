import { useEffect, useMemo } from "react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import {
  WORKSPACE_SETTINGS_NAV,
  allSettingsLeaves,
} from "./settings-nav";
import { SharedAgentResourcesPanel } from "./SharedAgentResourcesPanel";
import { ContainerRegistryPanel } from "./ContainerRegistryPanel";
import { WorkspaceSecretsPanel } from "./WorkspaceSecretsPanel";
import { WorkspaceMcpCatalogPanel } from "./WorkspaceMcpCatalogPanel";
import { WorkspaceSlackPanel } from "./WorkspaceSlackPanel";
import { WorkspaceSecurityPoliciesPanel } from "./WorkspaceSecurityPoliciesPanel";
import { MembersPanel } from "./MembersPanel";
import { AccessGrantsPanel } from "./AccessGrantsPanel";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { WorkspaceSettingsOverview } from "./WorkspaceSettingsOverview";
import { AnalyticsRoot } from "../analytics/AnalyticsRoot";

interface Props {
  workspaceSlug: string;
  /** Path suffix after `/workspaces/<slug>/settings` — e.g. `/insights/analytics`. */
  pathSuffix: string;
}

/**
 * Workspace settings shell. Picks one panel based on the URL, lets
 * the global sidebar handle navigation. Was previously a single
 * card-with-tabs that didn't scale past five children; now each
 * section is its own URL so the sidebar can group related leaves
 * and we can grow the IA without re-spending screen real estate.
 */
export function WorkspaceSettingsRoot({ workspaceSlug, pathSuffix }: Props) {
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

  // Empty pathSuffix → the overview screen (the /settings index).
  // Anything else resolves to a leaf via settings-nav; unknown
  // sub-paths fall back to the overview rather than 404 so a
  // typo in the URL doesn't strand the operator.
  const isOverview = pathSuffix === "";
  const leaf = useMemo(() => {
    if (isOverview) return null;
    const all = allSettingsLeaves();
    return all.find((l) => l.pathSuffix === pathSuffix) ?? null;
  }, [pathSuffix, isOverview]);

  const sectionTitle =
    WORKSPACE_SETTINGS_NAV.find((s) =>
      s.items.some((i) => i.pathSuffix === pathSuffix),
    )?.title ?? null;

  const headerTitle = isOverview
    ? "Workspace settings"
    : (leaf?.title ?? "Workspace settings");
  const headerDescription = isOverview
    ? "Identity, infrastructure, integrations, members, and insights for this workspace. Click any row below to drill into the underlying configuration."
    : leaf?.description;
  const headerEyebrow = isOverview ? "Overview" : sectionTitle;

  return (
    <AppShell
      breadcrumbs={[
        { label: workspaceSlug, href: `/workspaces/${workspaceSlug}` },
        isOverview
          ? { label: "Settings" }
          : {
              label: "Settings",
              href: `/workspaces/${workspaceSlug}/settings`,
            },
        ...(isOverview ? [] : [{ label: leaf?.title ?? "Overview" }]),
      ]}
    >
      <div className="space-y-1 p-6">
        <div className="mb-5 max-w-4xl space-y-1">
          {headerEyebrow && (
            <div className="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              {headerEyebrow}
            </div>
          )}
          <h1 className="text-xl font-semibold text-fg">{headerTitle}</h1>
          {headerDescription && (
            <p className="text-sm text-fg-muted">{headerDescription}</p>
          )}
        </div>
        <div className="max-w-4xl space-y-4">
          {isOverview ? (
            <WorkspaceSettingsOverview
              workspaceSlug={workspaceSlug}
              canManage={!!canManage}
            />
          ) : (
            renderPanel({
              workspaceSlug,
              pathSuffix: leaf?.pathSuffix ?? "",
              canManage: !!canManage,
            })
          )}
        </div>
      </div>
    </AppShell>
  );
}

function renderPanel({
  workspaceSlug,
  pathSuffix,
  canManage,
}: {
  workspaceSlug: string;
  pathSuffix: string;
  canManage: boolean;
}) {
  switch (pathSuffix) {
    case "/infrastructure/shared-resources":
      return (
        <SharedAgentResourcesPanel slug={workspaceSlug} canManage={canManage} />
      );
    case "/infrastructure/registry":
      return <ContainerRegistryPanel slug={workspaceSlug} />;
    case "/integrations/environment-variables":
      return (
        <WorkspaceSecretsPanel slug={workspaceSlug} canManage={canManage} />
      );
    case "/integrations/mcp":
      return (
        <WorkspaceMcpCatalogPanel slug={workspaceSlug} canManage={canManage} />
      );
    case "/integrations/slack":
      return <WorkspaceSlackPanel slug={workspaceSlug} canManage={canManage} />;
    case "/security/policies":
      return (
        <WorkspaceSecurityPoliciesPanel
          slug={workspaceSlug}
          canManage={canManage}
        />
      );
    case "/members/people":
      return <MembersPanel workspaceSlug={workspaceSlug} canManage={canManage} />;
    case "/members/access-grants":
      return (
        <AccessGrantsPanel slug={workspaceSlug} canManage={canManage} />
      );
    case "/members/groups":
      return (
        <PlaceholderPanel
          title="Groups"
          summary="Bundle members into groups for permission scoping."
          capabilities={[
            "Create named groups (e.g. Engineering, Finance, Founders).",
            "Assign workspace members to one or more groups.",
            "Scope agent / repo / collection access to groups, not individuals.",
            "Group-level token budgets surface in Insights → Analytics.",
          ]}
        />
      );
    case "/insights/analytics":
      return (
        <AnalyticsRoot workspaceSlug={workspaceSlug} canManage={canManage} />
      );
    case "/insights/audit":
      return (
        <PlaceholderPanel
          title="Audit log"
          summary="Who did what, when. For compliance and incident review."
          capabilities={[
            "Append-only log of every workspace mutation (member, agent, MCP, secret).",
            "Filter by actor, resource, action, time range.",
            "Export to CSV or stream to your SIEM via outbound webhook.",
            "Retain configurable per workspace (default 90 days).",
          ]}
        />
      );
    default:
      // Unknown sub-path — render the default panel without a scary
      // 404. The sidebar still reads the URL so the operator sees
      // they're in an unfamiliar place.
      return (
        <SharedAgentResourcesPanel slug={workspaceSlug} canManage={canManage} />
      );
  }
}
