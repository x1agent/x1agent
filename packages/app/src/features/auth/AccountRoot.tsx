import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAuthStore } from "../../stores/authStore";
import { useAccountsStore } from "../../stores/accountsStore";
import { Plus, X } from "lucide-react";
import { GitIdentitySection } from "./GitIdentitySection";

export function AccountRoot() {
  const { status, fetchMe } = useAuthStore();
  const {
    accounts,
    status: acctsStatus,
    load,
    startAddAccount,
    unlink,
  } = useAccountsStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status === "authenticated" && acctsStatus === "idle") load();
  }, [status, acctsStatus, load]);

  const params =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const linked = params?.get("linked") === "1";
  const error = params?.get("error");

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  return (
    <AppShell>
      <div className="p-8 space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-semibold">Linked accounts</h1>
          <p className="text-sm text-fg-muted">
            Google accounts attached to this person. Switch between them
            without signing out.
          </p>
        </div>

        {linked && (
          <Card className="border-green-900 bg-green-950/30">
            <CardContent className="py-3 text-sm text-green-300">
              Account linked.
            </CardContent>
          </Card>
        )}
        {error && (
          <Card className="border-red-900 bg-red-950/30">
            <CardContent className="py-3 text-sm text-red-300">
              Link failed: {error}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Accounts</CardTitle>
            <CardDescription>
              {accounts.length} linked to this person
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border-soft border-t border-border-soft">
            {accounts.map((a) => (
              <div
                key={a.user_id}
                className="flex items-center justify-between py-3"
              >
                <div>
                  <div className="text-sm">{a.name}</div>
                  <div className="text-xs text-fg-faint">
                    {a.email}
                    {a.is_current ? " · current" : ""}
                  </div>
                </div>
                {!a.is_current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => unlink(a.user_id)}
                  >
                    <X className="h-4 w-4" />
                    <span className="ml-1">Unlink</span>
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Button onClick={() => startAddAccount()}>
          <Plus className="h-4 w-4" /> Add Google account
        </Button>

        <GitIdentitySection />
      </div>
    </AppShell>
  );
}
