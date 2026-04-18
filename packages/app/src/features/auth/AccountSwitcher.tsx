import { useEffect } from "react";
import { ChevronsUpDown, LogOut, Plus } from "lucide-react";
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
  const { user, signOut } = useAuthStore();
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
          <span className="text-sm text-zinc-300">{user.email}</span>
          <ChevronsUpDown className="h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <DropdownMenuItem disabled className="flex flex-col items-start">
          <span className="text-sm text-zinc-100">{user.name}</span>
          <span className="text-xs text-zinc-500">{user.email}</span>
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
        <DropdownMenuItem onSelect={() => signOut()}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
