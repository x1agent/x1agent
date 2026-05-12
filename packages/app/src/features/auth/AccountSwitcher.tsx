import { useEffect } from "react";
import { ChevronsUpDown, LogOut, Plus, Shield } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useAuthStore } from "../../stores/authStore";
import { useAccountsStore } from "../../stores/accountsStore";

export function AccountSwitcher() {
  const { user, signOut, isPlatformAdmin } = useAuthStore();
  const { accounts, status, load, startAddAccount, switchTo } =
    useAccountsStore();

  useEffect(() => {
    if (status === "idle") load();
  }, [status, load]);

  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <span className="text-sm text-fg-muted">{user.email}</span>
          <ChevronsUpDown className="h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <DropdownMenuItem disabled className="flex flex-col items-start">
          <span className="text-sm text-fg">{user.name}</span>
          <span className="text-xs text-fg-faint">{user.email}</span>
        </DropdownMenuItem>

        {accounts.filter((a) => !a.is_current).length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Switch account</DropdownMenuLabel>
            {accounts
              .filter((a) => !a.is_current)
              .map((a) => (
                <DropdownMenuItem
                  key={a.user_id}
                  onSelect={() => switchTo(a.user_id)}
                >
                  {a.email}
                </DropdownMenuItem>
              ))}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => startAddAccount()}>
          <Plus className="mr-2 h-4 w-4" /> Add Google account
        </DropdownMenuItem>
        {/*
          X1A-46: Admin Settings entry. ADDITIVE — gated strictly on
          isPlatformAdmin. Do not refactor the surrounding menu shape:
          X1A-13 (account-page rework) and X1A-42 (account-level git
          identity) also land changes here, and the menu component is
          meant to change once across all three tickets. Server-side
          requirePlatformAdmin middleware on /api/admin/* enforces the
          gate; hiding-from-menu is defense in depth, not the gate.
        */}
        {isPlatformAdmin && (
          <DropdownMenuItem asChild>
            <a
              href="/admin/settings"
              data-testid="admin-settings-link"
              className="flex w-full items-center"
            >
              <Shield className="mr-2 h-4 w-4 text-accent" /> Admin Settings
              <span className="ml-auto rounded-sm bg-accent-soft px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-accent">
                New
              </span>
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => signOut()}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
