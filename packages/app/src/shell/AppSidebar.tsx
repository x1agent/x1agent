import { useEffect } from "react";
import {
  Bot,
  ChevronsUpDown,
  Database,
  LayoutDashboard,
  LogOut,
  MoreVertical,
  Play,
  Settings,
  Check,
  UserPlus,
} from "lucide-react";

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

interface NavItem {
  title: string;
  url: string;
  icon: typeof Bot;
}

export function AppSidebar() {
  const user = useAuthStore((s) => s.user);
  const memberships = useAuthStore((s) => s.memberships);
  const signOut = useAuthStore((s) => s.signOut);

  const activeSlug = useWorkspaceStore((s) => s.activeSlug);
  const syncSlugFromUrl = useWorkspaceStore((s) => s.syncSlugFromUrl);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);

  const linkedAccounts = useAccountsStore((s) => s.accounts);
  const loadAccounts = useAccountsStore((s) => s.load);
  const startAddAccount = useAccountsStore((s) => s.startAddAccount);

  useEffect(() => {
    syncSlugFromUrl();
    loadAccounts();
  }, [syncSlugFromUrl, loadAccounts]);

  const activeMembership = memberships.find((m) => m.slug === activeSlug);
  const otherAccounts = linkedAccounts.filter((a) => !a.is_current);

  const navBase = activeSlug ? `/workspaces/${activeSlug}` : "";
  const navItems: NavItem[] = activeSlug
    ? [
        { title: "Agents", url: `${navBase}`, icon: Bot },
        { title: "Sessions", url: `${navBase}/sessions`, icon: Play },
        { title: "Collections", url: `${navBase}/collections`, icon: Database },
        { title: "GitHub", url: `${navBase}/github`, icon: Github },
        { title: "Settings", url: `${navBase}/settings`, icon: Settings },
      ]
    : [];

  return (
    <Sidebar>
      <SidebarHeader className="space-y-2">
        <a
          href={activeSlug ? `/workspaces/${activeSlug}` : "/"}
          className="flex items-center gap-2 px-1 pb-1 text-zinc-100 hover:text-white"
        >
          <LayoutDashboard className="size-5" />
          <span className="text-base font-semibold tracking-tight">x1agent</span>
        </a>

        {activeMembership && (
          <div className="flex items-stretch gap-1 rounded-md border border-zinc-800 bg-zinc-900/40">
            <a
              href={`/workspaces/${activeSlug}/settings`}
              className="flex flex-1 items-center gap-2 rounded-l-md px-2 py-1.5 text-left text-sm hover:bg-zinc-900"
              title="Workspace settings"
            >
              <div className="flex size-6 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                {workspaceInitials(activeMembership.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {activeMembership.name}
                </div>
                <div className="truncate text-[10px] capitalize text-zinc-500">
                  {activeMembership.role}
                </div>
              </div>
              <Settings className="ml-auto size-3.5 text-zinc-500" />
            </a>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex items-center justify-center rounded-r-md border-l border-zinc-800 px-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
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
                <div className="px-2 py-1.5 text-xs font-medium text-zinc-500">
                  Workspaces
                </div>
                {memberships.map((ws) => (
                  <DropdownMenuItem
                    key={ws.workspace_id}
                    onClick={() => switchWorkspace(ws.slug)}
                    className="gap-2"
                  >
                    <div className="flex size-6 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                      {workspaceInitials(ws.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{ws.name}</div>
                      <div className="truncate text-[10px] capitalize text-zinc-500">
                        {ws.role}
                      </div>
                    </div>
                    {ws.slug === activeSlug && (
                      <Check className="size-4 text-zinc-500" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </SidebarHeader>

      <SidebarBody>
        {navItems.length > 0 && (
          <div>
            <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
              Platform
            </div>
            <nav className="flex flex-col">
              {navItems.map((item) => (
                <a
                  key={item.title}
                  href={item.url}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
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
          <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-zinc-900">
            <Avatar
              src={user?.avatar_url}
              fallback={initials(user?.name)}
              size="md"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{user?.name ?? "User"}</div>
              <div className="truncate text-[10px] text-zinc-500">
                {user?.email ?? ""}
              </div>
            </div>
            <MoreVertical className="ml-auto size-4 text-zinc-500" />
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
                      <div className="truncate text-xs text-zinc-500">
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
