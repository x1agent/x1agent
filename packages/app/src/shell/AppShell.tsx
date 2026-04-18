import { useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import { AccountSwitcher } from "../features/auth/AccountSwitcher";

interface AppShellProps {
  children: React.ReactNode;
  /** Hide the header for pages that render their own chrome (e.g. landing). */
  chrome?: boolean;
}

export function AppShell({ children, chrome = true }: AppShellProps) {
  const { status, fetchMe } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  return (
    <div className="min-h-screen">
      {chrome && (
        <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
          <a href="/" className="font-semibold tracking-tight">
            x1agent
          </a>
          {status === "authenticated" && <AccountSwitcher />}
        </header>
      )}
      <main>{children}</main>
    </div>
  );
}
