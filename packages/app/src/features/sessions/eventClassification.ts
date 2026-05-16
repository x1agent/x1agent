/**
 * Event classification for the session timeline.
 *
 * The timeline has two modes:
 *   - default ("compact")   — chronological view that hides the noisy
 *                             internals. Consecutive `agent.status`
 *                             entries collapse to the latest one (a
 *                             single line that mutates in place);
 *                             consecutive `agent.tool_call` entries
 *                             collapse into one `[ N tool calls ]`
 *                             pill the user can expand. Everything
 *                             else (text, shares, artifacts, prompts,
 *                             session banners) renders inline so the
 *                             conversational arc is preserved.
 *   - verbose               — renders the full event stream including
 *                             internals (tool searches, raw tool
 *                             results, thinking, session.init dumps).
 *
 * Tool-call mechanics matter for debugging but bury the signal an
 * operator wants in the calm view; collapse them but keep them one
 * click away.
 */
import type { SessionEventDTO } from "@x1agent/shared";

/**
 * Event types that are always considered public — they describe an
 * agent's state or visible output and belong in the calm default view.
 *
 * Kept around for callers that just want a per-type yes/no — the
 * compact-timeline grouper below uses a finer-grained `compactKind`.
 */
const PUBLIC_EVENT_TYPES = new Set<string>([
  "session.started",
  "session.completed",
  "session.failed",
  "session.resumed",
  "user.message",
  "user.input_response",
  "agent.text",
  "agent.status",
  "agent.artifact",
  "agent.share",
  "agent.input_request",
  "agent.permission_request",
  "agent.error",
]);

export function isPublicEventType(type: string): boolean {
  return PUBLIC_EVENT_TYPES.has(type);
}

/**
 * Returns the most recent public event from the stream, or `null` if
 * the stream contains no public events yet.
 *
 * Retained for older callers; the compact view now uses
 * `compactTimeline` instead. Walks from the tail to avoid sorting.
 */
export function latestPublicEvent(
  events: readonly SessionEventDTO[],
): SessionEventDTO | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && isPublicEventType(ev.type)) return ev;
  }
  return null;
}

/**
 * How a single event participates in the compact view.
 *   - "event"  — render with the regular EventCard, full content
 *   - "status" — collapse with adjacent statuses; only the latest renders
 *   - "tools"  — collapse with adjacent tool_calls into one pill
 *   - "hidden" — only shown in verbose
 */
export type CompactKind = "event" | "status" | "tools" | "hidden";

export function compactKind(type: string): CompactKind {
  if (type === "agent.status") return "status";
  if (type === "agent.tool_call") return "tools";
  if (PUBLIC_EVENT_TYPES.has(type)) return "event";
  return "hidden";
}

/**
 * X1A-110 — `user.message` rows whose payload carries
 * `kind: "comment_added" | "comment_resolved"` originated from a
 * share-comment wake (the agent received the wake as a user message;
 * the SSE round-trip stripped the structured metadata; the api's
 * subscriber re-derived `kind` from the wake-text header). These
 * belong in the share's comment flyout, not the main timeline.
 *
 * Server-side filter in `listSessionEvents` handles the initial-load /
 * refresh path; this client-side check covers the live WS-arriving
 * path so a freshly-posted comment doesn't flash into the timeline
 * for a beat before the page is refreshed.
 *
 * Returns "hidden" for matching rows, "event" otherwise — the caller
 * pairs this with `compactKind` so a `user.message` that's NOT a
 * comment wake still renders normally.
 */
export function isShareCommentWakeEvent(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  // X1A-133 — SDK-native origin envelope (PRD 0007) wins over the
  // legacy `kind` field. New share-comment wakes drop the `[wake: ...]`
  // prose preamble and carry origin.kind/server instead.
  const origin = (payload as { origin?: unknown }).origin;
  if (
    origin &&
    typeof origin === "object" &&
    (origin as { kind?: unknown }).kind === "channel" &&
    (origin as { server?: unknown }).server === "share-comments"
  ) {
    return true;
  }
  const kind = (payload as { kind?: unknown }).kind;
  return kind === "comment_added" || kind === "comment_resolved";
}

/**
 * One row in the compact timeline.
 *
 * `key` is stable across re-grouping so React reuses the same DOM
 * node when a status collapses-and-replaces or a tools group grows
 * — that's what makes status feel like an in-place mutation rather
 * than a flash of new card.
 */
export type CompactItem =
  | { kind: "event"; key: string; event: SessionEventDTO }
  | { kind: "status"; key: string; latest: SessionEventDTO }
  | { kind: "tools"; key: string; events: readonly SessionEventDTO[] };

const itemKey = (e: SessionEventDTO) => `${e.session_id}-${e.seq}`;

/**
 * Walk events in order, emitting compact rows. Hidden events are
 * dropped. Adjacent status/tools entries are merged with the *first*
 * group's key — so the row's identity sticks to where the run started.
 *
 * `agent.share` events with a duplicate `share_id` collapse onto the
 * original pill's slot — the latest payload wins, the timeline
 * position doesn't jump. This is the consumer side of the sidecar's
 * update-mode contract: when the agent re-shares with an existing
 * share_id, the operator sees the same pill update in place, comments
 * stay attached (they're keyed by share_id, which didn't move), and
 * the chat reads naturally instead of growing a fresh pill for each
 * revision.
 */
export function compactTimeline(
  events: readonly SessionEventDTO[],
): CompactItem[] {
  const out: CompactItem[] = [];
  const sharePillIdxByShareId = new Map<string, number>();
  for (const ev of events) {
    // X1A-110 — drop share-comment wakes before any compact-grouping
    // happens. They look like `user.message` but belong in the share
    // flyout, not the main session timeline.
    if (ev.type === "user.message" && isShareCommentWakeEvent(ev.payload)) {
      continue;
    }
    const k = compactKind(ev.type);
    if (k === "hidden") continue;
    if (k === "event") {
      if (ev.type === "agent.share") {
        const shareId = (ev.payload as { share_id?: string } | null)
          ?.share_id;
        if (shareId) {
          const priorIdx = sharePillIdxByShareId.get(shareId);
          if (priorIdx !== undefined) {
            const prior = out[priorIdx]!;
            if (prior.kind === "event") {
              // Keep the original React key so the pill subtree
              // doesn't unmount/remount on update.
              out[priorIdx] = { kind: "event", key: prior.key, event: ev };
            }
            continue;
          }
          sharePillIdxByShareId.set(shareId, out.length);
        }
      }
      out.push({ kind: "event", key: itemKey(ev), event: ev });
      continue;
    }
    const last = out[out.length - 1];
    if (k === "status") {
      if (last?.kind === "status") {
        out[out.length - 1] = { kind: "status", key: last.key, latest: ev };
      } else {
        out.push({ kind: "status", key: itemKey(ev), latest: ev });
      }
      continue;
    }
    // tools
    if (last?.kind === "tools") {
      out[out.length - 1] = {
        kind: "tools",
        key: last.key,
        events: [...last.events, ev],
      };
    } else {
      out.push({ kind: "tools", key: itemKey(ev), events: [ev] });
    }
  }
  return out;
}
