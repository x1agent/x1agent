import type { Session, SessionId } from "./session.js";
import type { SessionEvent } from "./event.js";

/**
 * Pure helpers for building the session-history markdown that gets
 * mounted into a resumed session pod at `/workspace/session_history.md`.
 *
 * Factored out of the resume flow so they're easy to unit-test without
 * any DB dependency; the job-watcher is the only caller in production,
 * via the `resumedFromSessionId` on a pending session row.
 */

export interface SessionLike {
  id: SessionId;
  agentId: string;
  resumedFromSessionId: SessionId | null;
  triggeredAt: Date;
}

/**
 * Walk the resumed_from chain back to the root, returning sessions in
 * chronological order (oldest first). The loader is injected so tests
 * can pass an in-memory lookup.
 *
 * Detects cycles via a visited set — a corrupt chain (A->B->A) returns
 * the partial chain up to the cycle point and stops, rather than
 * looping forever.
 */
export async function walkResumeChain<S extends SessionLike>(
  origin: S,
  loadSession: (id: SessionId) => Promise<S | null>,
): Promise<S[]> {
  const chain: S[] = [];
  const visited = new Set<SessionId>();
  let current: S | null = origin;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    if (current.resumedFromSessionId) {
      current = await loadSession(current.resumedFromSessionId);
    } else {
      break;
    }
  }
  return chain;
}

/**
 * Format a single session's events as a list of markdown lines. Pure.
 * Only events that carry user-visible meaning are rendered; lifecycle
 * events (session.started / completed / init) and tool-result noise
 * are skipped so the agent reading the history focuses on the
 * conversation + artifacts.
 */
export function formatEventsAsMarkdown(
  events: readonly SessionEvent[],
): string[] {
  const lines: string[] = [];
  for (const e of events) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const time = new Date(e.createdAt).toLocaleTimeString();

    switch (e.type) {
      case "user.message":
      case "user.input_response": {
        const text = String(payload.text ?? payload.answer ?? "");
        lines.push(`**User** (${time}): ${text}\n`);
        break;
      }
      case "agent.text":
        lines.push(`**Agent** (${time}): ${String(payload.text ?? "")}\n`);
        break;
      case "agent.thinking": {
        const snippet = String(payload.text ?? "").slice(0, 200);
        lines.push(`*Agent thinking*: ${snippet}...\n`);
        break;
      }
      case "agent.tool_call":
        lines.push(`> Tool: ${String(payload.tool_name ?? "unknown")}\n`);
        break;
      case "agent.artifact": {
        const title = String(payload.title ?? "Untitled");
        const kind = String(payload.artifact_type ?? "");
        const content = String(payload.content ?? "").slice(0, 500);
        lines.push(
          `**Artifact** — ${title} (${kind})\n\`\`\`\n${content}\n\`\`\`\n`,
        );
        break;
      }
      case "agent.share": {
        const title = String(payload.title ?? "Untitled");
        const shareKind = String(payload.share_type ?? "");
        // share_id is the load-bearing field — without it the agent
        // can recall *that* it made a share but not call read_share()
        // or update the same share by id. Surface it explicitly so a
        // resumed session can `mcp__x1agent__read_share(share_id=…)`
        // to fetch the bytes and pass the same id back to `share`
        // when publishing the next revision.
        const shareId = String(payload.share_id ?? "");
        lines.push(
          shareId
            ? `**Shared** — ${title} (${shareKind}) · share_id: \`${shareId}\`\n`
            : `**Shared** — ${title} (${shareKind})\n`,
        );
        break;
      }
      case "agent.status":
        lines.push(
          `*Status*: ${String(payload.status ?? "")} — ${String(payload.detail ?? "")}\n`,
        );
        break;
      case "agent.error":
        lines.push(`**Error**: ${String(payload.message ?? "")}\n`);
        break;
      // Skip session lifecycle, init, tool_result noise by design.
    }
  }
  return lines;
}

/**
 * Build the full session-history markdown for a resume. Pure function
 * given a chain of sessions + their events.
 *
 * `chain` must be in chronological order (oldest first) — produced
 * by walkResumeChain.
 */
export function buildSessionHistory(
  chain: readonly Session[],
  eventsBySessionId: ReadonlyMap<SessionId, readonly SessionEvent[]>,
): string {
  if (chain.length === 0) return "";

  const root = chain[0]!;

  const lines: string[] = [
    `# Session History`,
    ``,
    `This session is a continuation of ${chain.length} prior session${chain.length > 1 ? "s" : ""}.`,
    `Agent: ${root.agentId}`,
    ``,
    `---`,
    ``,
  ];

  for (let idx = 0; idx < chain.length; idx++) {
    const session = chain[idx]!;
    lines.push(`## Session ${idx + 1}/${chain.length} — ${session.id}`);
    lines.push(`Started: ${session.triggeredAt.toISOString()}`);
    lines.push(``);

    const events = eventsBySessionId.get(session.id) ?? [];
    lines.push(...formatEventsAsMarkdown(events));

    lines.push(`---`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * The agent-side prompt used when a session is resumed. Tells the
 * agent where to find the history file before it waits for the next
 * user message.
 */
export const SESSION_RESUME_PROMPT =
  "You are resuming a previous session. Read /workspace/session_history.md for full context of what happened before. Any **Shared** entries list the `share_id` of an artifact you published earlier — call `mcp__x1agent__read_share` with that id to fetch the bytes, and pass the SAME id back to the `share` tool when you publish an updated version so it lands on the same pill instead of creating a new one. Then wait for the user's next message.";
