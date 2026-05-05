import { useEffect, useMemo } from "react";
import { Sparkles } from "lucide-react";
import { AppShell } from "../../shell/AppShell";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceSessionsStore } from "../../stores/workspaceSessionsStore";
import { NewSessionComposer } from "../sessions/NewSessionComposer";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import type { SessionStatus, WorkspaceSessionRow } from "@x1agent/shared";

interface Props {
  slug: string;
}

const STATUS_VARIANT: Record<SessionStatus, BadgeVariant> = {
  pending: "secondary",
  running: "info",
  complete: "success",
  failed: "danger",
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Up late";
}

function firstName(full?: string | null, email?: string | null): string {
  if (full && full.trim()) return full.trim().split(/\s+/)[0] ?? full.trim();
  if (email) return email.split("@")[0] ?? email;
  return "there";
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Workspace driver home — lands here when the operator clicks the
 * workspace chip. Inspired by Zapier / Claude Desktop:
 *
 *   1. Time-aware greeting + small spark icon
 *   2. NewSessionComposer (centered, primary surface)
 *   3. "Recent conversations" — last 3 sessions, click to resume
 *
 * Workspace settings (was the previous home content) lives at
 * /workspaces/<slug>/settings, reachable via the cog on the
 * workspace chip in the sidebar.
 *
 * TODO: real session titles. Today we render "<agent name> · <time>"
 * as a placeholder because SessionDTO has no title/summary field.
 * Wire that up via an LLM-generated summary on session completion or
 * a derived first-prompt snippet from session_events.
 */
export function WorkspaceRoot({ slug }: Props) {
  const { user, memberships, status, fetchMe } = useAuthStore();
  const { bySlug, load } = useWorkspaceSessionsStore();

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  const ws = memberships.find((m) => m.slug === slug);

  useEffect(() => {
    if (ws) void load(slug);
  }, [slug, ws, load]);

  const allRows = bySlug[slug] ?? [];
  const myUserId = user?.id;
  const recent = useMemo<WorkspaceSessionRow[]>(() => {
    return allRows
      .filter(
        (r) =>
          r.triggered_by === "user" &&
          (!myUserId || r.triggered_by_user_id === myUserId),
      )
      .slice()
      .sort(
        (a, b) =>
          new Date(b.triggered_at).getTime() -
          new Date(a.triggered_at).getTime(),
      )
      .slice(0, 3);
  }, [allRows, myUserId]);

  if (status === "loading" || status === "idle") {
    return (
      <AppShell>
        <div className="p-8 text-sm text-fg-muted">Loading…</div>
      </AppShell>
    );
  }
  if (status === "anonymous") {
    if (typeof window !== "undefined") window.location.href = "/";
    return null;
  }

  if (!ws) {
    return (
      <AppShell>
        <div className="space-y-2 p-8">
          <h1 className="text-xl font-semibold">Workspace not found</h1>
          <p className="text-sm text-fg-muted">
            You are not a member of <code>{slug}</code>.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-6 pt-16 pb-12">
        {/* Greeting + spark glyph. Kept small so the composer below
            remains the page's primary visual. */}
        <div className="mb-6 flex flex-col items-center text-center">
          <Sparkles className="mb-3 size-6 text-accent" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            {greeting()}, {firstName(user?.name, user?.email)}
          </h1>
        </div>

        <NewSessionComposer
          workspaceSlug={slug}
          placeholder="What are you working on today?"
        />

        {recent.length > 0 && (
          <div className="mt-10">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-fg">
                Recent conversations
              </h2>
              <a
                href={`/workspaces/${slug}/sessions/`}
                className="text-xs text-fg-muted transition hover:text-fg"
              >
                View all
              </a>
            </div>
            <ul className="surface-card divide-y divide-border-soft overflow-hidden">
              {recent.map((s) => (
                <li key={s.id}>
                  <a
                    href={`/workspaces/${slug}/sessions/${s.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition hover:bg-bg-elevated/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">
                        {s.agent?.name ?? "Untitled session"}
                      </div>
                      <div className="text-[11px] text-fg-faint">
                        {relativeTime(s.triggered_at)}
                        {s.id ? ` · ${s.id.slice(0, 8)}` : ""}
                      </div>
                    </div>
                    <Badge variant={STATUS_VARIANT[s.status]}>
                      {s.status}
                    </Badge>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </AppShell>
  );
}
