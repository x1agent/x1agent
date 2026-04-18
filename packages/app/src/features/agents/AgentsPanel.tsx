import { useEffect } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useAgentsStore } from "../../stores/agentsStore";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

export function AgentsPanel({ workspaceSlug, canManage }: Props) {
  const { bySlug, loadingSlug, errorBySlug, load } = useAgentsStore();
  const rows = bySlug[workspaceSlug] ?? [];
  const error = errorBySlug[workspaceSlug];

  useEffect(() => {
    load(workspaceSlug);
  }, [workspaceSlug, load]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle>Agents</CardTitle>
          <CardDescription>
            Configurable agent runtimes. Each can have a schedule, a system
            prompt, heartbeat instructions, and linked GitHub repos.
          </CardDescription>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <a href={`/workspaces/${workspaceSlug}/agents/new`}>New agent</a>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {loadingSlug === workspaceSlug && (
          <div className="text-sm text-zinc-400">Loading…</div>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
        {rows.length === 0 && loadingSlug !== workspaceSlug && (
          <div className="text-sm text-zinc-500">
            No agents yet. Create one to get started.
          </div>
        )}
        {rows.length > 0 && (
          <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {rows.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div>
                  <a
                    href={`/workspaces/${workspaceSlug}/agents/${a.slug}`}
                    className="text-zinc-100 hover:underline"
                  >
                    {a.name}
                  </a>
                  <div className="text-xs text-zinc-500">
                    {a.runtime_type}
                    {a.schedule ? ` · ${a.schedule}` : " · manual"}
                    {a.is_active ? "" : " · paused"}
                  </div>
                </div>
                <div className="text-xs text-zinc-500">{a.slug}</div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
