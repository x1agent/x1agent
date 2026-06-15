import { useEffect } from "react";
import { ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAuthStore } from "../../stores/authStore";
import { useSharedResourcesStore } from "../../stores/sharedResourcesStore";
import { useImagesStore } from "../../stores/imagesStore";
import { useWorkspaceSecretsStore } from "../../stores/workspaceSecretsStore";
import { useMcpStore } from "../../stores/mcpStore";
import { useInvitationsStore } from "../../stores/invitationsStore";
import { useAnalyticsStore } from "../../stores/analyticsStore";
import { WORKSPACE_SETTINGS_NAV } from "./settings-nav";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

/**
 * Settings overview screen — what you land on at /workspaces/<slug>/settings.
 *
 * Same pattern as the agent detail page: one card per section with
 * one row per leaf, each row linking into the corresponding sub-page.
 * The summary value answers "what's configured here right now"
 * (counts, status mix, headline number) so an operator can scan the
 * whole workspace's config in a single screen and click directly to
 * whichever leaf needs attention.
 */
export function WorkspaceSettingsOverview({
  workspaceSlug,
  canManage,
}: Props) {
  const user = useAuthStore((s) => s.user);
  const memberships = useAuthStore((s) => s.memberships);
  const ws = memberships.find((m) => m.slug === workspaceSlug);

  // Each store loads on mount; the overview pulls a count from each
  // and renders. Skips loading when the operator can't manage — the
  // sub-pages would refuse anyway.
  const loadResources = useSharedResourcesStore((s) => s.load);
  const installedBySlug = useSharedResourcesStore((s) => s.installedBySlug);

  const loadImages = useImagesStore((s) => s.load);
  const imagesBySlug = useImagesStore((s) => s.bySlug);

  const loadSecrets = useWorkspaceSecretsStore((s) => s.load);
  const secretsByWorkspace = useWorkspaceSecretsStore((s) => s.byWorkspace);

  const loadCatalog = useMcpStore((s) => s.loadCatalog);
  const loadUserTokens = useMcpStore((s) => s.loadUserTokens);
  const catalogBySlug = useMcpStore((s) => s.catalogBySlug);
  const userTokens = useMcpStore((s) => s.userTokens);

  const loadInvitations = useInvitationsStore((s) => s.load);
  const invitationsBySlug = useInvitationsStore((s) => s.bySlug);

  const loadAnalytics = useAnalyticsStore((s) => s.load);
  const analyticsByWorkspace = useAnalyticsStore((s) => s.byWorkspace);

  useEffect(() => {
    if (!canManage) return;
    void loadResources(workspaceSlug);
    void loadImages(workspaceSlug);
    void loadSecrets(workspaceSlug);
    void loadCatalog(workspaceSlug);
    void loadUserTokens();
    void loadInvitations(workspaceSlug);
    void loadAnalytics(workspaceSlug);
  }, [
    canManage,
    workspaceSlug,
    loadResources,
    loadImages,
    loadSecrets,
    loadCatalog,
    loadUserTokens,
    loadInvitations,
    loadAnalytics,
  ]);

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-fg-faint">
          Only workspace admins and owners can view workspace settings.
        </CardContent>
      </Card>
    );
  }

  const installed = installedBySlug[workspaceSlug] ?? [];
  const installedRunning = installed.filter((r) => r.status === "running").length;
  const images = imagesBySlug[workspaceSlug] ?? [];
  const secrets = secretsByWorkspace[workspaceSlug] ?? [];
  const catalog = catalogBySlug[workspaceSlug] ?? [];
  const remoteOAuthCount = catalog.filter((c) => c.kind === "remote_oauth").length;
  const connectedTokens = userTokens.filter((t) => {
    const matchesCatalog = catalog.some((c) => c.id === t.catalog_entry_id);
    if (!matchesCatalog) return false;
    if (!t.access_token_expires_at) return true;
    const expired =
      Date.parse(t.access_token_expires_at) < Date.now() &&
      !t.has_refresh_token;
    return !expired;
  }).length;
  const invitations = invitationsBySlug[workspaceSlug] ?? [];
  // "Pending" = not accepted, not revoked, not yet expired. Matches
  // the same filter the InvitationsPanel uses.
  const now = Date.now();
  const pendingInvites = invitations.filter(
    (i) =>
      !i.accepted_at &&
      !i.revoked_at &&
      Date.parse(i.expires_at) > now,
  ).length;

  const analyticsData = analyticsByWorkspace[workspaceSlug]?.data ?? null;
  const analyticsCost = analyticsData?.totals.costUsdEstimate ?? null;
  const analyticsCacheSavings =
    analyticsData?.totals.cacheSavingsUsdEstimate ?? null;

  const baseHref = `/workspaces/${workspaceSlug}/settings`;

  return (
    <div className="space-y-4">
      {/* Identity ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Signed in as</CardTitle>
          <CardDescription>{user?.email}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-fg-muted">
          role: <span className="capitalize text-fg">{ws?.role ?? "—"}</span>
        </CardContent>
      </Card>

      {/* Insights summary ───────────────────────────────────────────
       * Headline cost stat that opens the analytics deep-dive. The
       * existing detail tab below is kept too; this is the at-a-glance
       * version that lives alongside identity. */}
      <a
        href={`${baseHref}/insights/analytics`}
        className="group block transition"
      >
        <Card className="transition group-hover:bg-bg-elevated/40">
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle>Insights</CardTitle>
              <CardDescription>
                {analyticsCost === null
                  ? "Loading…"
                  : analyticsCost === 0
                    ? "No spend in the current period."
                    : `Estimated spend this period`}
              </CardDescription>
            </div>
            <ChevronRight className="size-4 shrink-0 text-fg-faint/50 group-hover:text-fg-muted" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-6">
              <Stat
                label="Estimated cost"
                value={
                  analyticsCost === null
                    ? "—"
                    : analyticsCost === 0
                      ? "$0"
                      : formatUsd(analyticsCost)
                }
                large
              />
              <Stat
                label="Cache savings"
                value={
                  analyticsCacheSavings && analyticsCacheSavings > 0
                    ? formatUsd(analyticsCacheSavings)
                    : "—"
                }
              />
              <Stat
                label="Audit"
                value="Coming soon"
                muted
              />
            </div>
          </CardContent>
        </Card>
      </a>

      {/* Your workspaces ────────────────────────────────────────── */}
      {memberships.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Your workspaces</CardTitle>
            <CardDescription>
              Switch between any workspace you're a member of.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border-soft border-t border-border-soft">
              {memberships.map((m) => (
                <a
                  key={m.workspace_id}
                  href={`/workspaces/${m.slug}/`}
                  className={`flex items-center gap-3 px-4 py-3 transition hover:bg-bg-elevated/50 ${
                    m.slug === workspaceSlug
                      ? "text-fg"
                      : "text-fg-muted hover:text-fg"
                  }`}
                >
                  <span className="text-sm font-medium">{m.name}</span>
                  <span className="ml-auto text-[11px] capitalize text-fg-faint">
                    {m.role}
                  </span>
                  {m.slug === workspaceSlug && (
                    <span className="rounded-sm bg-bg-muted/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
                      current
                    </span>
                  )}
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detail tabs ────────────────────────────────────────────── */}
      <SectionCard
        title="Infrastructure"
        description="Long-lived workloads agents persist into."
      >
        <SummaryRow
          href={`${baseHref}/infrastructure/shared-resources`}
          label="Shared resources"
          value={
            installed.length === 0
              ? "Nothing installed"
              : `${installed.length} installed${installedRunning > 0 ? ` · ${installedRunning} running` : ""}`
          }
          muted={installed.length === 0}
        />
        <SummaryRow
          href={`${baseHref}/infrastructure/registry`}
          label="Container registry"
          value={
            images.length === 0
              ? "No images pushed"
              : `${images.length} image${images.length === 1 ? "" : "s"}`
          }
          muted={images.length === 0}
          last
        />
      </SectionCard>

      <SectionCard
        title="Integrations"
        description="Where the workspace connects out — secrets and MCP servers."
      >
        <SummaryRow
          href={`${baseHref}/integrations/environment-variables`}
          label="Workspace secrets"
          value={
            secrets.length === 0
              ? "No secrets configured"
              : `${secrets.length} secret${secrets.length === 1 ? "" : "s"}`
          }
          muted={secrets.length === 0}
        />
        <SummaryRow
          href={`${baseHref}/integrations/mcp`}
          label="MCP servers"
          value={
            catalog.length === 0
              ? "No MCP servers registered"
              : `${catalog.length} registered${remoteOAuthCount > 0 ? ` · ${connectedTokens}/${remoteOAuthCount} OAuth connected` : ""}`
          }
          muted={catalog.length === 0}
          last
        />
      </SectionCard>

      <SectionCard
        title="Members"
        description="People in this workspace, plus future group scoping."
      >
        <SummaryRow
          href={`${baseHref}/members/people`}
          label="People"
          value={
            pendingInvites > 0
              ? `${pendingInvites} pending invitation${pendingInvites === 1 ? "" : "s"}`
              : "Manage invitations"
          }
        />
        <SummaryRow
          label="Groups"
          value="Coming soon"
          comingSoon
          last
        />
      </SectionCard>

      <SectionCard
        title="Insights"
        description="What the workspace has been spending and doing."
      >
        <SummaryRow
          href={`${baseHref}/insights/analytics`}
          label="Analytics"
          value={
            analyticsCost === null
              ? "Loading…"
              : analyticsCost === 0
                ? "No spend in current period"
                : analyticsCacheSavings && analyticsCacheSavings > 0.01
                  ? `${formatUsd(analyticsCost)} this month · ${formatUsd(analyticsCacheSavings)} saved via cache`
                  : `${formatUsd(analyticsCost)} this month`
          }
          muted={analyticsCost === 0}
        />
        <SummaryRow
          label="Audit log"
          value="Coming soon"
          comingSoon
          last
        />
      </SectionCard>
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  // Pull the section's icon from the nav config so the overview's
  // section header matches the sidebar visually.
  const sectionMeta = WORKSPACE_SETTINGS_NAV.find((s) => s.title === title);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border-soft border-t border-border-soft">
          {/* sectionMeta is read for parity with the sidebar; if a
              future section ships an icon we'd render here. */}
          {sectionMeta ? children : children}
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryRow({
  href,
  label,
  value,
  muted,
  comingSoon,
  last,
}: {
  href?: string;
  label: string;
  value: string;
  muted?: boolean;
  comingSoon?: boolean;
  last?: boolean;
}) {
  const valueClass = comingSoon
    ? "text-fg-faint/70 italic"
    : muted
      ? "text-fg-faint"
      : "text-fg";

  const content = (
    <>
      <span className="text-sm font-medium text-fg-muted">{label}</span>
      <span className={`ml-auto truncate text-sm ${valueClass}`}>{value}</span>
      {href && !comingSoon && (
        <ChevronRight className="size-4 shrink-0 text-fg-faint/40 group-hover:text-fg-muted" />
      )}
    </>
  );

  const base = `group flex items-center gap-3 px-4 py-3 ${last ? "" : "border-b border-border-soft"}`;

  if (!href || comingSoon) {
    return <div className={base}>{content}</div>;
  }
  return (
    <a href={href} className={`${base} transition-colors hover:bg-bg-elevated/50`}>
      {content}
    </a>
  );
}

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function Stat({
  label,
  value,
  large,
  muted,
}: {
  label: string;
  value: string;
  large?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
        {label}
      </div>
      <div
        className={`${large ? "text-2xl" : "text-base"} font-semibold ${
          muted ? "text-fg-faint" : "text-fg"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
