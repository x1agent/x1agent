import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { AppShell } from "../../shell/AppShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useAuthStore } from "../../stores/authStore";

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  member_count: number;
  agent_count: number;
}

interface ListResponse {
  workspaces: WorkspaceRow[];
}

export function WorkspacesRoot() {
  const { status, fetchMe, isPlatformAdmin } = useAuthStore();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status !== "authenticated") return;
    apiFetch<ListResponse>("/api/admin/workspaces")
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [status]);

  if (status === "anonymous" && typeof window !== "undefined") {
    window.location.href = "/";
    return null;
  }

  if (status === "authenticated" && !isPlatformAdmin) {
    return (
      <AppShell
        breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Workspaces" }]}
      >
        <div className="p-8 text-sm text-fg-muted">Platform admin only.</div>
      </AppShell>
    );
  }

  return (
    <AppShell
      breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Workspaces" }]}
    >
      <div className="max-w-5xl space-y-6 p-6">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <CardTitle>Workspaces</CardTitle>
              <CardDescription>
                Every workspace in this deployment. Read-only — manage members
                and agents from inside the workspace.
              </CardDescription>
            </div>
            <a
              href="/workspaces/new"
              className="inline-flex shrink-0 items-center rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-bg hover:bg-fg/90"
            >
              New workspace
            </a>
          </CardHeader>
          <CardContent>
            {error && <div className="mb-4 text-sm text-red-400">{error}</div>}
            {!data && !error && (
              <div className="text-sm text-fg-faint">Loading…</div>
            )}
            {data && data.workspaces.length === 0 && (
              <div className="text-sm text-fg-faint">No workspaces yet.</div>
            )}
            {data && data.workspaces.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead className="w-32 text-right">Members</TableHead>
                    <TableHead className="w-32 text-right">Agents</TableHead>
                    <TableHead className="w-48">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.workspaces.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell>
                        <a
                          href={`/workspaces/${w.slug}`}
                          className="text-fg hover:underline"
                        >
                          <div className="font-medium">{w.name}</div>
                          <div className="font-mono text-[11px] text-fg-faint">
                            {w.slug}
                          </div>
                        </a>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.member_count}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.agent_count}
                      </TableCell>
                      <TableCell className="text-xs text-fg-faint">
                        {new Date(w.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
