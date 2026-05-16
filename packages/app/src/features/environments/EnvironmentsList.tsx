import { useEffect } from "react";
import {
  usePreviewEnvironmentsStore,
  type DeployStatus,
  type PreviewEnvironmentDTO,
} from "../../stores/previewEnvironmentsStore";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

function StatusPill({ status }: { status: DeployStatus }) {
  const styles: Record<DeployStatus, string> = {
    pending: "bg-yellow-500/15 text-yellow-300",
    provisioning: "bg-blue-500/15 text-blue-300",
    ready: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-red-500/15 text-red-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never deployed";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / (24 * 3_600_000))}d ago`;
}

function EnvironmentRow({
  env,
  workspaceSlug,
}: {
  env: PreviewEnvironmentDTO;
  workspaceSlug: string;
}) {
  return (
    <li className="rounded-lg border border-border-soft bg-bg-elevated/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <a
            href={`/workspaces/${workspaceSlug}/environments/${env.id}`}
            className="text-base font-medium text-fg hover:underline"
          >
            {env.title}
          </a>
          <div className="mt-0.5 text-xs text-fg-muted">
            <code className="text-fg">{env.slug}</code>
            <span className="mx-1.5">·</span>
            {env.repo_full_name}
            <span className="mx-1.5">·</span>
            {env.branch}
          </div>
        </div>
        <StatusPill status={env.last_deploy_status} />
      </div>

      {env.last_deploy_url && env.last_deploy_status === "ready" && (
        <a
          href={env.last_deploy_url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-sm text-accent hover:underline"
        >
          {env.last_deploy_url} ↗
        </a>
      )}
      {env.last_deploy_status === "failed" && env.last_deploy_status_reason && (
        <p className="mt-3 text-sm text-red-300">
          {env.last_deploy_status_reason}
        </p>
      )}
      <div className="mt-2 text-xs text-fg-muted">
        {env.last_deploy_sha && (
          <>
            <code>{env.last_deploy_sha.slice(0, 12)}</code>
            <span className="mx-1.5">·</span>
          </>
        )}
        {relativeTime(env.last_deploy_at)}
      </div>
    </li>
  );
}

export function EnvironmentsList({ workspaceSlug, canManage }: Props) {
  // canManage is referenced once the rename + delete inline controls
  // land; for the list-only view today it doesn't change rendering.
  void canManage;

  const list = usePreviewEnvironmentsStore(
    (s) => s.byWorkspace[workspaceSlug] ?? EMPTY,
  );
  const status = usePreviewEnvironmentsStore(
    (s) => s.status[workspaceSlug] ?? "idle",
  );
  const error = usePreviewEnvironmentsStore(
    (s) => s.error[workspaceSlug] ?? null,
  );
  const load = usePreviewEnvironmentsStore((s) => s.loadForWorkspace);

  useEffect(() => {
    if (status === "idle") load(workspaceSlug);
  }, [status, workspaceSlug, load]);

  if (status === "loading" || status === "idle") {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }
  if (status === "error") {
    return <p className="text-sm text-red-300">{error}</p>;
  }
  if (list.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-soft p-6 text-sm text-fg-muted">
        <p className="mb-1 text-fg">No preview environments yet.</p>
        <p>
          Have an agent call{" "}
          <code className="rounded bg-bg-elevated px-1 text-xs">
            preview_deploy
          </code>
          {" "}with a repo + branch + sha. A row will appear here on the first
          successful deploy and update in place on every subsequent deploy.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {list.map((env) => (
        <EnvironmentRow
          key={env.id}
          env={env}
          workspaceSlug={workspaceSlug}
        />
      ))}
    </ul>
  );
}

// Stable empty-array reference so selectors don't trip React's
// referential-equality bailout — see CLAUDE.md zustand foot-gun note.
const EMPTY: PreviewEnvironmentDTO[] = [];
