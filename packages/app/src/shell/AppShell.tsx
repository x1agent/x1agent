import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "../stores/authStore";
import { SidebarContent, SidebarProvider, SidebarTrigger } from "./Sidebar";
import { AppSidebar } from "./AppSidebar";

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
      <div className="min-h-svh bg-zinc-950 text-zinc-100">{children}</div>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarContent>
        <header className="flex items-center gap-3 border-b border-zinc-900 px-4 py-2.5">
          <SidebarTrigger />
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav className="flex items-center gap-1.5 text-sm text-zinc-500">
              {breadcrumbs.map((crumb, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {crumb.href ? (
                    <a href={crumb.href} className="hover:text-zinc-200">
                      {crumb.label}
                    </a>
                  ) : (
                    <span className="text-zinc-400">{crumb.label}</span>
                  )}
                  {i < breadcrumbs.length - 1 && (
                    <span className="text-zinc-700">/</span>
                  )}
                </span>
              ))}
            </nav>
          )}
          {title && (
            <h1 className="text-sm font-medium text-zinc-100">{title}</h1>
          )}
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </SidebarContent>
    </SidebarProvider>
  );
}
