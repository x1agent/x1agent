import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "../stores/authStore";
import { SidebarContent, SidebarProvider, SidebarTrigger } from "./Sidebar";
import { AppSidebar } from "./AppSidebar";
import { ThemeToggle } from "../features/theme/ThemeToggle";

interface AppShellProps {
  children: ReactNode;
  /** When false, drops the sidebar + chrome (landing, sign-in, invite flows). */
  chrome?: boolean;
  /** Page title shown in the thin top header next to the sidebar trigger. */
  title?: string;
  /** Breadcrumbs left of the title. Each item renders as a link when href is set. */
  breadcrumbs?: { label: string; href?: string }[];
  /** Right-aligned header slot, for per-page actions (buttons, filters). */
  actions?: ReactNode;
}

/**
 * Two-column shell per docs/architecture/information-architecture.md.
 * Desktop pins a 240px sidebar; mobile collapses it to an off-canvas
 * drawer toggled by the hamburger in the header. Every workspace page
 * uses this; sign-in / landing / invite pass `chrome={false}`.
 */
export function AppShell({
  children,
  chrome = true,
  title,
  breadcrumbs,
  actions,
}: AppShellProps) {
  const { status, fetchMe } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  if (!chrome) {
    return (
      <div className="min-h-svh bg-bg text-fg">{children}</div>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarContent>
        <header className="sticky top-0 z-30 flex items-center gap-3 bg-canvas px-4 py-2.5">
          <SidebarTrigger />
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav className="flex items-center gap-1.5 text-sm text-fg-faint">
              {breadcrumbs.map((crumb, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {crumb.href ? (
                    <a href={crumb.href} className="hover:text-fg">
                      {crumb.label}
                    </a>
                  ) : (
                    <span className="text-fg-muted">{crumb.label}</span>
                  )}
                  {i < breadcrumbs.length - 1 && (
                    <span className="text-fg-faint/50">/</span>
                  )}
                </span>
              ))}
            </nav>
          )}
          {title && (
            <h1 className="text-sm font-medium text-fg">{title}</h1>
          )}
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto bg-canvas">{children}</main>
      </SidebarContent>
    </SidebarProvider>
  );
}
