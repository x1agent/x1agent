import type { SessionDTO } from "@x1agent/shared";

interface Props {
  /** May be null while the page is still loading the session record. */
  session: SessionDTO | null | undefined;
  /** Authoritative session id from the URL — used for the fallback hash. */
  sessionId: string;
}

/**
 * Header title for the session detail page.
 *
 * Sessions don't have human-given names. Until the LLM summarizer has
 * run at least once (see packages/domains/sessions/src/application/
 * maybe-update-session-summary.ts) the only "name" we can show is a
 * slice of the UUID. Once a summary is persisted on the row the API
 * returns it on `session.summary` — render that as the title and keep
 * the hash as a small monospace co-pilot for unambiguous reference.
 *
 * The summary has no enforced length cap server-side, and the
 * containing flex row can shrink under narrow screens or when the
 * Resume / Verbose buttons take more space, so the visible text MUST
 * use Tailwind's `truncate` utility. See packages/app/CLAUDE.md
 * § "Use truncate / text-overflow: ellipsis".
 */
export function SessionTitle({ session, sessionId }: Props) {
  const summary = session?.summary?.trim() ?? "";
  const shortId = sessionId.slice(0, 8);

  if (summary) {
    return (
      <div
        className="flex min-w-0 flex-1 items-baseline gap-2"
        data-testid="session-title"
      >
        <span
          className="truncate text-sm font-medium text-fg"
          title={summary}
        >
          {summary}
        </span>
        <span
          className="shrink-0 font-mono text-[11px] text-fg-faint/70"
          title={sessionId}
        >
          {shortId}
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-1 items-baseline gap-2"
      data-testid="session-title"
    >
      <span
        className="truncate font-mono text-sm text-fg-muted"
        title={sessionId}
      >
        {shortId}
      </span>
      <span className="shrink-0 text-[11px] text-fg-faint/70">
        no summary yet
      </span>
    </div>
  );
}
