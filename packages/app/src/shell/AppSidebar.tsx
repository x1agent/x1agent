import { useEffect } from "react";
import {
  Bot,
  ChevronsUpDown,
  Database,
  FileText,
  LayoutGrid,
  LogOut,
  MoreVertical,
  Play,
  Settings,
  Check,
  UserPlus,
} from "lucide-react";
import { ADMIN_NAV } from "../features/admin/nav";
import {
  WORKSPACE_SETTINGS_NAV,
  leafFromPathname,
} from "../features/workspaces/settings-nav";

// Brand mark — checkmark in a rounded square. Matches the marketing
// site (x1agent-web Nav/Footer) so the logo is consistent across the
// product and the public surface. Size convention is `size-6` (24px),
// same as marketing; the sidebar previously used `size-5`.
function X1AgentLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M7 12 L11 16 L17 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Our lucide-react build doesn't ship brand icons. Tiny inline SVG
// component keeps the same consumer shape `<Icon className="size-4" />`.
function Github({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.1 3.3 9.4 7.8 10.9.6.1.8-.2.8-.6v-2.2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.2-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 1.7 2.6 1.2 3.2.9.1-.7.4-1.2.7-1.5-2.5-.3-5.2-1.3-5.2-5.6 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1.9-.2 1.8-.4 2.8-.4s1.9.1 2.8.4c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.8 1.1 3 0 4.3-2.6 5.3-5.2 5.6.4.3.7 1 .7 2v2.9c0 .4.2.6.8.6 4.5-1.5 7.8-5.8 7.8-10.9A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}
import {
  Sidebar,
  SidebarBody,
  SidebarFooter,
  SidebarHeader,
} from "./Sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Avatar, initials, workspaceInitials } from "../components/ui/avatar";
import { useAuthStore } from "../stores/authStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAccountsStore } from "../stores/accountsStore";
import {
  useCapabilitiesStore,
  useHasCollections,
} from "../stores/capabilitiesStore";

interface NavItem {
  title: string;
  url: string;
  // Accepts both lucide-react icons (typeof Bot) and the inline Github
  // SVG component above — both have the same `({ className }) => JSX`
  // call shape.
  icon: React.ComponentType<{ className?: string }>;
}

export function AppSidebar() {
  const user = useAuthStore((s) => s.user);
  const memberships = useAuthStore((s) => s.memberships);
  const isPlatformAdmin = useAuthStore((s) => s.isPlatformAdmin);
  const signOut = useAuthStore((s) => s.signOut);

  const activeSlug = useWorkspaceStore((s) => s.activeSlug);
  const syncSlugFromUrl = useWorkspaceStore((s) => s.syncSlugFromUrl);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);

  const linkedAccounts = useAccountsStore((s) => s.accounts);
  const loadAccounts = useAccountsStore((s) => s.load);
  const startAddAccount = useAccountsStore((s) => s.startAddAccount);

  const fetchCapabilities = useCapabilitiesStore((s) => s.fetch);
  const hasCollections = useHasCollections();

  useEffect(() => {
    syncSlugFromUrl();
    loadAccounts();
    fetchCapabilities();
  }, [syncSlugFromUrl, loadAccounts, fetchCapabilities]);

  const activeMembership = memberships.find((m) => m.slug === activeSlug);
  const otherAccounts = linkedAccounts.filter((a) => !a.is_current);

  // Mode the sidebar's nav is in. Workspace pages (agents, sessions,
  // shares, etc.) get the Platform list; the cog-driven settings area
  // and any /admin/* page get the Admin list. The two are mutually
  // exclusive — showing both at once was confusing because the
  // operator never wants to action both contexts in the same click.
  const pathname =
    typeof window !== "undefined" ? window.location.pathname : "/";
  const onAdminRoute = pathname.startsWith("/admin");
  const onWorkspaceSettings = /^\/workspaces\/[^/]+\/settings(\/|$)/.test(
    pathname,
  );
  const inAdminContext = onAdminRoute || onWorkspaceSettings;

  // The workspace chip is a workspace-scope cue. Hide it on cluster
  // /admin/* (no workspace there); keep it on /workspaces/.../settings
  // since the operator is editing THAT workspace.
  const showWorkspaceChip = !!activeMembership && !onAdminRoute;

  const navBase = activeSlug ? `/workspaces/${activeSlug}` : "";
  const navItems: NavItem[] = activeSlug
    ? [
        // Sessions is reachable from the workspace home's "View all"
        // link — keeping it out of the rail keeps the rail focused on
        // configuration surfaces, not transient state.
        { title: "Agents", url: `${navBase}/agents`, icon: Bot },
        { title: "Shares", url: `${navBase}/shares`, icon: FileText },
        // Collections live behind a graph provider — hide the entry
        // when the deployment ships without one (see capabilitiesStore).
        ...(hasCollections
          ? [
              {
                title: "Collections",
                url: `${navBase}/collections`,
                icon: Database,
              },
            ]
          : []),
        { title: "GitHub", url: `${navBase}/github`, icon: Github },
        { title: "Settings", url: `${navBase}/settings`, icon: Settings },
      ]
    : [];

  return (
    <Sidebar>
      <SidebarHeader className="space-y-2">
        <a
          href={activeSlug ? `/workspaces/${activeSlug}` : "/"}
          className="flex items-center gap-2 px-1 pb-1 text-fg hover:text-white"
        >
          <X1AgentLogo className="size-6" />
          <span className="text-base font-semibold tracking-tight">x1agent</span>
        </a>

        {showWorkspaceChip && activeMembership && (
          <div className="flex items-stretch gap-1 rounded-md border border-border-soft bg-bg-elevated/40">
            {/* Body: clicks to the workspace home (driver page). */}
            <a
              href={`/workspaces/${activeSlug}/`}
              className="flex flex-1 items-center gap-2 rounded-l-md px-2 py-1.5 text-left text-sm hover:bg-bg-elevated"
              title="Workspace home"
            >
              <div className="flex size-6 shrink-0 items-center justify-center rounded bg-bg-muted text-[10px] font-semibold text-fg-muted">
                {workspaceInitials(activeMembership.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {activeMembership.name}
                </div>
                <div className="truncate text-[10px] capitalize text-fg-faint">
                  {activeMembership.role}
                </div>
              </div>
            </a>
            {/* Cog: clicks to workspace settings. Standalone target so
                the body can route to the home page above. */}
            <a
              href={`/workspaces/${activeSlug}/settings`}
              title="Workspace settings"
              aria-label="Workspace settings"
              className="flex items-center justify-center border-l border-border-soft px-2 text-fg-faint hover:bg-bg-elevated hover:text-fg"
            >
              <Settings className="size-3.5" />
            </a>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex items-center justify-center rounded-r-md border-l border-border-soft px-2 text-fg-faint hover:bg-bg-elevated hover:text-fg"
                title="Switch workspace"
              >
                <ChevronsUpDown className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-64"
                side="right"
                align="start"
                sideOffset={4}
              >
                <div className="px-2 py-1.5 text-xs font-medium text-fg-faint">
                  Workspaces
                </div>
                {memberships.map((ws) => (
                  <DropdownMenuItem
                    key={ws.workspace_id}
                    onClick={() => switchWorkspace(ws.slug)}
                    className="gap-2"
                  >
                    <div className="flex size-6 shrink-0 items-center justify-center rounded bg-bg-muted text-[10px] font-semibold text-fg-muted">
                      {workspaceInitials(ws.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{ws.name}</div>
                      <div className="truncate text-[10px] capitalize text-fg-faint">
                        {ws.role}
                      </div>
                    </div>
                    {ws.slug === activeSlug && (
                      <Check className="size-4 text-fg-faint" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </SidebarHeader>

      <SidebarBody>
        {!inAdminContext && navItems.length > 0 && (
          <div>
            <nav className="flex flex-col">
              {navItems.map((item) => (
                <a
                  key={item.title}
                  href={item.url}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted hover:bg-bg-elevated hover:text-fg"
                >
                  <item.icon className="size-4" />
                  <span>{item.title}</span>
                </a>
              ))}
            </nav>
          </div>
        )}
        {/*
          Workspace settings sidebar — grouped sections so the IA
          scales with feature growth. Active leaf is derived from
          the URL via leafFromPathname so direct-link refreshes
          highlight the right item.
        */}
        {onWorkspaceSettings && activeSlug && (
          <WorkspaceSettingsNav
            workspaceSlug={activeSlug}
            currentPath={pathname}
          />
        )}
        {/*
          Cluster admin nav only shows on /admin/* — never on
          /workspaces/.../settings, even if the operator is also a
          platform admin. Mixing cluster-scope items into a workspace-
          scope settings sidebar reads as if they're scoped to that
          workspace.
        */}
        {onAdminRoute && isPlatformAdmin && (
          <div>
            <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-fg-faint/70">
              Platform admin
            </div>
            <nav className="flex flex-col">
              {ADMIN_NAV.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted hover:bg-bg-elevated hover:text-fg"
                >
                  <item.icon className="size-4" />
                  <span>{item.title}</span>
                </a>
              ))}
            </nav>
          </div>
        )}
      </SidebarBody>

      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md border border-border-soft bg-bg-elevated/40 p-1.5 text-left hover:bg-bg-elevated">
            <Avatar
              src={user?.avatar_url}
              fallback={initials(user?.name)}
              size="md"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{user?.name ?? "User"}</div>
              <div className="truncate text-[10px] text-fg-faint">
                {user?.email ?? ""}
              </div>
            </div>
            <MoreVertical className="ml-auto size-4 text-fg-faint" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-64"
            side="right"
            align="end"
            sideOffset={4}
          >
            {otherAccounts.length > 0 && (
              <>
                {otherAccounts.map((acc) => (
                  <DropdownMenuItem
                    key={acc.user_id}
                    className="gap-2"
                    onClick={() =>
                      useAccountsStore
                        .getState()
                        .switchTo(acc.user_id)
                        .catch((err) => console.error("[switch]", err))
                    }
                  >
                    <Avatar fallback={initials(acc.name)} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{acc.name}</div>
                      <div className="truncate text-xs text-fg-faint">
                        {acc.email}
                      </div>
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onClick={() =>
                startAddAccount().catch((err) =>
                  console.error("[add account]", err),
                )
              }
            >
              <UserPlus className="mr-2 size-4" />
              Add account
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => (window.location.href = "/account")}>
              <Settings className="mr-2 size-4" />
              My account
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => signOut()}>
              <LogOut className="mr-2 size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Sidebar nav for /workspaces/<slug>/settings/*. Renders the
 * grouped sections from settings-nav.ts as a single panel with a
 * "Workspace settings" header. Active leaf gets a left-border
 * accent + brighter text; placeholder leaves dim slightly.
 */
function WorkspaceSettingsNav({
  workspaceSlug,
  currentPath,
}: {
  workspaceSlug: string;
  currentPath: string;
}) {
  const active = leafFromPathname(currentPath);
  // Overview is the index route — match it explicitly so the active
  // accent appears on the right item when no sub-path is in the URL.
  const overviewHref = `/workspaces/${workspaceSlug}/settings`;
  const isOverview =
    currentPath === overviewHref || currentPath === `${overviewHref}/`;

  return (
    <div className="space-y-3">
      <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-fg-faint/70">
        Workspace settings
      </div>
      <nav className="flex flex-col">
        <a
          href={overviewHref}
          className={`relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
            isOverview
              ? "bg-bg-elevated text-fg"
              : "text-fg-muted hover:bg-bg-elevated/60 hover:text-fg"
          }`}
          aria-current={isOverview ? "page" : undefined}
        >
          {isOverview && (
            <span
              className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-fg"
              aria-hidden="true"
            />
          )}
          <LayoutGrid className="size-4" />
          <span>Overview</span>
        </a>
      </nav>
      {WORKSPACE_SETTINGS_NAV.map((section) => (
        <div key={section.title} className="space-y-0.5">
          <div className="px-2 text-[10px] font-medium uppercase tracking-wider text-fg-faint">
            {section.title}
          </div>
          <nav className="flex flex-col">
            {section.items.map((item) => {
              const href = `/workspaces/${workspaceSlug}/settings${item.pathSuffix}`;
              const isActive = active?.pathSuffix === item.pathSuffix;
              return (
                <a
                  key={item.pathSuffix}
                  href={href}
                  className={`relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-bg-elevated text-fg"
                      : "text-fg-muted hover:bg-bg-elevated/60 hover:text-fg"
                  } ${item.placeholder ? "text-fg-faint" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                >
                  {isActive && (
                    <span
                      className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-fg"
                      aria-hidden="true"
                    />
                  )}
                  <item.icon className="size-4" />
                  <span className="truncate">{item.title}</span>
                  {item.placeholder && (
                    <span className="ml-auto rounded-sm bg-bg-muted/80 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-fg-faint">
                      Soon
                    </span>
                  )}
                </a>
              );
            })}
          </nav>
        </div>
      ))}
    </div>
  );
}

