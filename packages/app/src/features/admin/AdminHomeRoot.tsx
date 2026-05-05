import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAuthStore } from "../../stores/authStore";
import { ADMIN_NAV } from "./nav";

export function AdminHomeRoot() {
  const { status, fetchMe, isPlatformAdmin } = useAuthStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  if (status === "authenticated" && !isPlatformAdmin) {
    return (
      <AppShell breadcrumbs={[{ label: "Admin" }]}>
        <div className="p-8 text-sm text-fg-muted">Platform admin only.</div>
      </AppShell>
    );
  }

  const items = ADMIN_NAV.filter((item) => item.href !== "/admin");

  return (
    <AppShell breadcrumbs={[{ label: "Admin" }]}>
      <div className="max-w-5xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Cluster-wide settings that cut across workspaces. Everything
            here is platform-admin only.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <a key={item.href} href={item.href} className="block">
                <Card className="h-full transition-colors hover:border-border-strong">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Icon className="size-4 text-fg-muted" />
                      {item.title}
                    </CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                  </CardHeader>
                  <CardContent />
                </Card>
              </a>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
