import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { MermaidDiagram } from "./MermaidDiagram";
import { SharePill } from "./SharePill";
import { UploadedImagePill } from "./UploadedImagePill";
import { parseImageTokens } from "../../lib/imageTokens";
import { markdownComponents } from "./markdown-components";
import { Button } from "../../components/ui/button";
import { apiFetch } from "../../lib/api";
import {
  useSessionDetailStore,
  type ChildRef,
} from "../../stores/sessionDetailStore";

interface Props {
  event: SessionEventDTO;
  verbose?: boolean;
  onRespond?: (text: string, requestId: string) => void;
  workspaceSlug: string;
  agentId?: string;
  sessionId: string;
}

type Payload = Record<string, unknown>;

function p(event: SessionEventDTO): Payload {
  return (event.payload ?? {}) as Payload;
}

function isMermaid(content: string): boolean {
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|journey|mindmap|timeline)\b/i.test(
    content.trim(),
  );
}

/**
 * Platform-originated wakes (server-driven) arrive as user.message
 * events with `source: "platform"` and a `kind` discriminator. We
 * render them distinctly from human-typed messages so operators can
 * tell at a glance what drove a given turn. See
 * docs/architecture/orchestration.md § Server-driven wakes.
 */
// Unified quiet treatment for all wake kinds — the pill is meant to
// recede into the timeline, not announce itself with per-kind colors.
// Theme-aware tokens: muted background + soft border, flips with the
// surface ladder in both light and dark mode.
const WAKE_PANEL_CLASS = "border-border-soft bg-bg-elevated/50";

// Short bracketed tag rendered on the pill. Operator-facing copy —
// jargon-y engineer terms ("watchdog", "scheduler heartbeat") get
// translated to plain-language equivalents.
const WAKE_KIND_LABELS: Record<string, string> = {
  state_change: "child finished",
  heartbeat: "scheduler tick",
  watchdog: "child silent",
  checkup: "checkup",
  message: "message from child",
};

const EMPTY_CHILDREN: readonly ChildRef[] = [];

/**
 * Render a session-id short prefix as a clickable link when we can
 * resolve it to a known child of the current session; otherwise as
 * inert text. `stopPropagation` keeps the click from bubbling to the
 * surrounding expand/collapse toggle.
 */
function SessionShortLink({
  shortId,
  childrenByShortId,
  workspaceSlug,
}: {
  shortId: string;
  childrenByShortId: Map<string, ChildRef>;
  workspaceSlug: string;
}) {
  const child = childrenByShortId.get(shortId);
  if (!child) {
    return <code className="font-mono text-fg">{shortId}</code>;
  }
  return (
    <a
      href={`/workspaces/${workspaceSlug}/sessions/${child.id}`}
      onClick={(e) => e.stopPropagation()}
      className="font-mono text-fg underline decoration-dotted underline-offset-2 hover:text-fg hover:decoration-solid"
      title={`${child.agent.name ?? child.agent.slug} · ${child.status}`}
    >
      {shortId}
    </a>
  );
}

/**
 * Build an operator-readable one-line summary from a wake event's
 * kind + text. Returns a fragment with embedded clickable links for
 * any child-session short ids it can resolve.
 *
 * The platform's text format is the contract here; the regexes below
 * track the literals emitted by `format*WakeText` in
 * packages/api/src/orchestration/wake-publisher.ts.
 */
function WakeSummary({
  kind,
  text,
  childrenByShortId,
  workspaceSlug,
}: {
  kind: string;
  text: string;
  childrenByShortId: Map<string, ChildRef>;
  workspaceSlug: string;
}) {
  switch (kind) {
    case "watchdog": {
      const m = text.match(
        /Child session ([0-9a-f]{8})[^.]*emitted no events for (\d+) minutes/,
      );
      if (m) {
        return (
          <>
            Session{" "}
            <SessionShortLink
              shortId={m[1]!}
              childrenByShortId={childrenByShortId}
              workspaceSlug={workspaceSlug}
            />{" "}
            has not emitted anything in {m[2]} minutes.
          </>
        );
      }
      return <>Child silent.</>;
    }
    case "state_change": {
      const m = text.match(
        /Child session ([0-9a-f]{8})[^.]*transitioned to (complete|failed)/,
      );
      if (m) {
        const verb = m[2] === "complete" ? "completed" : "failed";
        return (
          <>
            Session{" "}
            <SessionShortLink
              shortId={m[1]!}
              childrenByShortId={childrenByShortId}
              workspaceSlug={workspaceSlug}
            />{" "}
            {verb}.
          </>
        );
      }
      return <>Child transitioned.</>;
    }
    case "checkup": {
      const m = text.match(/Active children \((\d+)\)/);
      if (m) return <>{m[1]} children active.</>;
      return <>No children currently in flight.</>;
    }
    case "heartbeat":
      return <>Scheduler tick fired.</>;
    case "message": {
      const m = text.match(/Child session ([0-9a-f]{8})/);
      if (m) {
        return (
          <>
            Session{" "}
            <SessionShortLink
              shortId={m[1]!}
              childrenByShortId={childrenByShortId}
              workspaceSlug={workspaceSlug}
            />{" "}
            sent a signal.
          </>
        );
      }
      return <>Child sent a signal.</>;
    }
    default:
      return <>System event.</>;
  }
}

/**
 * Platform-injected wake messages — the api server posts these as
 * user.message events into orchestrator sessions when something
 * happens that warrants the orchestrator's attention (a child
 * finished, a child has gone silent, a scheduled tick fired, etc.).
 *
 * Rendered as a small pill that recedes into the timeline with an
 * operator-readable one-line summary. Clicking expands the original
 * platform-emitted prose. Any child-session id referenced in the
 * summary is a link back to that child session for traversal.
 *
 * Wake-text content is generated by `format*WakeText` helpers in
 * `packages/api/src/orchestration/wake-publisher.ts`; the regexes in
 * `WakeSummary` track those literals.
 */
function PlatformWakePill({
  event,
  kind,
  label,
  workspaceSlug,
}: {
  event: SessionEventDTO;
  kind: string;
  label: string;
  workspaceSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const payload = p(event);
  const text = String(payload["text"] ?? "");
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const Icon = open ? ChevronDown : ChevronRight;

  // Build a short-id → ChildRef map from the current session's
  // children (already loaded by SessionRoot via sessionDetailStore).
  // Wake-publisher renders short ids as the first 8 hex chars of the
  // child's session UUID. Pre-dashed UUIDs start with 8 hex chars
  // too, so `id.slice(0, 8)` matches both shapes.
  const children = useSessionDetailStore(
    (s) => s.childrenBySession[event.session_id] ?? EMPTY_CHILDREN,
  );
  const childrenByShortId = useMemo(() => {
    const m = new Map<string, ChildRef>();
    for (const c of children) m.set(c.id.slice(0, 8), c);
    return m;
  }, [children]);

  return (
    <div className="my-1">
      <div className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-soft bg-bg-elevated/30 px-2 py-1 text-[11px] text-fg-muted hover:border-border-strong">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} system event — ${label}`}
          className="inline-flex items-center text-fg-faint hover:text-fg"
        >
          <Icon className="size-3" />
        </button>
        <span className="rounded bg-bg-muted px-1.5 py-0.5 font-medium text-fg">
          [{label}]
        </span>
        <span className="min-w-0 truncate text-fg">
          <WakeSummary
            kind={kind}
            text={text}
            childrenByShortId={childrenByShortId}
            workspaceSlug={workspaceSlug}
          />
        </span>
        <span className="shrink-0 text-fg-faint">· {time}</span>
      </div>
      {open && (
        <pre
          className={`mt-1 whitespace-pre-wrap rounded-md border ${WAKE_PANEL_CLASS} px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-muted`}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

// Stopgap until session_events rows carry real `source`, `kind`,
// `from_session_id` columns. Historic rows (and rows persisted by an
// older api before the .events subscriber learned to enrich) only
// have `text`. We re-derive the wake kind from the well-known text
// header so the pill renders. Stays in sync with the literals in
// `format*WakeText` in packages/api/src/orchestration/wake-publisher.ts.
function deriveWakeKindFromText(text: string): string | null {
  if (!text.startsWith("[driverless wake:")) return null;
  const closingBracket = text.indexOf("]");
  if (closingBracket < 0) return null;
  const header = text
    .slice("[driverless wake:".length, closingBracket)
    .trim();
  if (header.startsWith("watchdog")) return "watchdog";
  if (header.startsWith("scheduler heartbeat")) return "heartbeat";
  if (header.startsWith("platform checkup")) return "checkup";
  if (header.startsWith("message from child")) return "message";
  if (
    header.startsWith("child finished") ||
    header.startsWith("child failed") ||
    header.startsWith("child completed") ||
    header.startsWith("child transitioned")
  )
    return "state_change";
  return null;
}

function UserBubble({
  event,
  workspaceSlug,
}: {
  event: SessionEventDTO;
  workspaceSlug: string;
}) {
  const payload = p(event);
  const fromSessionId = payload["from_session_id"] as string | undefined;
  const fromAgent = payload["from_agent_slug"] as string | undefined;
  const sourceField = payload["source"] as string | undefined;
  const kindField = payload["kind"] as string | undefined;
  const text = typeof payload["text"] === "string"
    ? (payload["text"] as string)
    : "";

  // Source-of-truth: explicit `source` / `kind` fields on the payload
  // (set by the api's .events enricher for new rows). Fallback for
  // historic rows that lack them: derive from the text header.
  const fallbackKind =
    !sourceField && !kindField ? deriveWakeKindFromText(text) : null;
  const resolvedKind =
    sourceField === "platform" && kindField && WAKE_KIND_LABELS[kindField]
      ? kindField
      : fallbackKind && WAKE_KIND_LABELS[fallbackKind]
        ? fallbackKind
        : null;
  if (resolvedKind) {
    return (
      <PlatformWakePill
        event={event}
        kind={resolvedKind}
        label={WAKE_KIND_LABELS[resolvedKind]!}
        workspaceSlug={workspaceSlug}
      />
    );
  }

  // User turns: subtle right-aligned bubble. Light tint distinguishes
  // from the agent's flat prose without the heavy chat-app shape we
  // used to have. Matches the Zapier reference (Image 7).
  return (
    <div className="flex justify-end py-3">
      <div className="max-w-[80%] rounded-2xl bg-bg-elevated/70 px-4 py-2.5 text-[15px] leading-7 text-fg">
        <UserBubbleBody body={String(payload["text"] ?? "")} />
        {fromSessionId && (
          <div className="mt-1 text-[10px] text-fg-faint">
            from session {String(fromSessionId).slice(0, 8)}
            {fromAgent ? ` · ${fromAgent}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Renders a user message body, swapping `[image: <uuid>]` tokens for
 * inline `UploadedImagePill`s and dropping the file-path "(user attached
 * file: …)" sentences the agent's /inject handler rewrites them into —
 * those are for the LLM, not for the human reading the timeline. Plain
 * prose between tokens keeps its whitespace and line breaks.
 */
function UserBubbleBody({ body }: { body: string }) {
  const blocks = parseImageTokens(body);
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <p key={i} className="whitespace-pre-wrap">
            {b.value.trim()}
          </p>
        ) : (
          <div key={i} className="flex justify-end">
            <UploadedImagePill uploadId={b.id} />
          </div>
        ),
      )}
    </div>
  );
}

function AgentText({ event }: { event: SessionEventDTO }) {
  const text = String(p(event)["text"] ?? "");
  return (
    <div className="py-3 text-[15px] leading-7 text-fg">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  );
}

function ResumedDivider() {
  return (
    <div className="my-3 flex justify-center py-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
        Session resumed
      </span>
    </div>
  );
}

function SessionBanner({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  const type = event.type;
  let label = "Session started";
  let tone = "text-emerald-400/70";
  if (type === "session.completed") {
    label = `Session completed${typeof payload["result"] === "string" && payload["result"].includes("inactivity") ? " (idle timeout)" : ""}`;
    tone = "text-fg-faint";
  } else if (type === "session.failed") {
    label = `Session failed${payload["error"] ? `: ${String(payload["error"])}` : ""}`;
    tone = "text-red-400/80";
  }
  return (
    <div className="my-3 flex justify-center py-1">
      <span
        className={`flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide ${tone}`}
      >
        <span>{label}</span>
        <span className="text-fg-faint/70">·</span>
        <span className="text-fg-faint">
          {new Date(event.timestamp).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </span>
    </div>
  );
}

function StatusCard({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-fg-faint">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
      <span className="capitalize">{String(payload["status"] ?? "")}</span>
      {payload["detail"] && (
        <span className="text-fg-muted">— {String(payload["detail"])}</span>
      )}
    </div>
  );
}

function ArtifactCard({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  const content = String(payload["content"] ?? "");
  const kind = String(payload["artifact_type"] ?? "other");
  const title = String(payload["title"] ?? "artifact");
  const mermaid = isMermaid(content);
  const isCode = kind === "code" && !mermaid;
  return (
    <div className="py-3">
      <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-fg-faint">
        <span>{mermaid ? "diagram" : kind}</span>
        <span className="text-fg-faint/40">·</span>
        <span className="font-medium text-fg-muted">{title}</span>
      </div>
      {mermaid ? (
        <MermaidDiagram content={content} />
      ) : isCode ? (
        <pre className="overflow-x-auto rounded-md bg-bg-elevated/80 p-3 text-xs text-fg">
          {content}
        </pre>
      ) : (
        <div className="text-[15px] leading-7 text-fg">
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </Markdown>
        </div>
      )}
    </div>
  );
}

function InputRequestCard({
  event,
  onRespond,
}: {
  event: SessionEventDTO;
  onRespond?: (text: string, requestId: string) => void;
}) {
  const payload = p(event);
  const options = (payload["options"] as string[] | undefined) ?? [];
  const requestId = String(payload["request_id"] ?? "");
  return (
    <div className="py-3">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-amber-400/80">
        Agent is asking
      </div>
      <p className="text-[15px] leading-7 text-fg">
        {String(payload["question"] ?? "The agent has a question.")}
      </p>
      {options.length > 0 && onRespond && (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => onRespond(opt, requestId)}
              className="rounded-md border border-border-soft bg-surface px-3 py-1 text-sm text-fg transition hover:border-accent/60 hover:bg-accent-soft"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionRequestCard({
  event,
  onRespond,
  workspaceSlug,
  agentId,
  sessionId,
}: {
  event: SessionEventDTO;
  onRespond?: (text: string, requestId: string) => void;
  workspaceSlug: string;
  agentId?: string;
  sessionId: string;
}) {
  const payload = p(event);
  const requestId = String(payload["request_id"] ?? "");
  const grantType = String(payload["grant_type"] ?? "");
  const scope = String(payload["scope"] ?? "once");
  const justification = String(payload["justification"] ?? "");
  const details = (payload["details"] ?? {}) as Record<string, unknown>;

  const [state, setState] = useState<
    "pending" | "approving" | "approved" | "denied" | "error"
  >("pending");
  const [error, setError] = useState<string | null>(null);

  const summarize = (): string => {
    if (grantType === "tool_scope") {
      return String(details["scope"] ?? grantType);
    }
    if (grantType === "spawn") {
      return `spawn ${String(details["child_agent_id"] ?? "")}`;
    }
    return grantType;
  };

  const approve = async () => {
    if (!agentId) {
      setState("error");
      setError("agent id unknown — cannot create grant");
      return;
    }
    setState("approving");
    setError(null);
    try {
      const body: Record<string, unknown> = {
        agent_subject_id: agentId,
        grant_type: grantType,
        details,
        scope,
        reason: `agent requested: ${justification.slice(0, 200)}`,
      };
      if (scope === "session") body["session_id"] = sessionId;
      const res = await apiFetch<{ grant: { id: string } }>(
        `/api/workspaces/${workspaceSlug}/grants`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setState("approved");
      onRespond?.(
        `Permission approved: ${summarize()} (${scope}). Grant id: ${res.grant.id}.`,
        requestId,
      );
    } catch (err) {
      setState("error");
      setError((err as Error).message);
    }
  };

  const deny = () => {
    setState("denied");
    onRespond?.(
      `Permission denied: ${summarize()}. Do not try again for this scope without a new user instruction.`,
      requestId,
    );
  };

  return (
    <div className="py-3">
      <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-amber-400/80">
        <span>Permission request</span>
        <span className="text-fg-faint/40">·</span>
        <span className="text-fg-muted">{grantType}</span>
        <span className="text-fg-faint/40">·</span>
        <span className="text-fg-muted">{scope}</span>
      </div>
      <p className="text-[15px] leading-7 text-fg">
        The agent is asking for{" "}
        <span className="font-medium">{summarize()}</span>.
      </p>
      {justification && (
        <p className="mt-1 whitespace-pre-wrap text-[14px] leading-6 text-fg-muted">
          {justification}
        </p>
      )}
      {state === "error" && error && (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      )}
      {state === "pending" || state === "approving" || state === "error" ? (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={approve}
            disabled={state === "approving" || !agentId}
          >
            {state === "approving" ? "Approving…" : "Approve"}
          </Button>
          <Button size="sm" variant="outline" onClick={deny}>
            Deny
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-fg-faint">
          {state === "approved" ? "Approved." : "Denied."}
        </p>
      )}
    </div>
  );
}

function ErrorCard({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  return (
    <div className="py-2 text-sm text-red-400">
      <span>{String(payload["message"] ?? "")}</span>
      {payload["recoverable"] === true && (
        <span className="ml-2 text-xs text-fg-faint">(continuing)</span>
      )}
    </div>
  );
}

function VerboseThinking({ event }: { event: SessionEventDTO }) {
  const [open, setOpen] = useState(false);
  const text = String(p(event)["text"] ?? "");
  if (!text) return null;
  return (
    <div className="py-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300"
      >
        Thinking
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-purple-900 pl-3 text-xs text-fg-muted">
          {text}
        </div>
      )}
    </div>
  );
}

// Internal MCP tools whose `agent.tool_call` events we suppress from the
// raw JSON card because the SAME call also produces a nicely-rendered
// companion event (agent.status, agent.artifact, agent.error, etc.).
// Showing both is pure noise — the companion card has the same content
// in a user-friendly shape. Keep this list in sync with the set of MCP
// tools that emit structured events back into the session stream.
const SUPPRESSED_RAW_TOOL_CALLS = new Set<string>([
  "mcp__x1agent__emit_status",
  "mcp__x1agent__emit_artifact",
  "mcp__x1agent__emit_error",
  "mcp__x1agent__request_input",
  "mcp__x1agent__request_permission",
  "mcp__x1agent__request_grant",
  "mcp__x1agent__share",
  "mcp__x1agent__end_session",
]);

function ToolCallCard({ event }: { event: SessionEventDTO }) {
  const [open, setOpen] = useState(false);
  const payload = p(event);
  const name = String(payload["tool_name"] ?? "tool");
  if (SUPPRESSED_RAW_TOOL_CALLS.has(name)) return null;
  const input = payload["input"] ?? {};
  return (
    <div className="py-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-fg-muted hover:text-fg"
      >
        <span className="rounded bg-bg-muted px-2 py-0.5 font-mono text-[10px]">
          {name}
        </span>
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <pre className="mt-1 overflow-x-auto rounded-md bg-bg-elevated p-2 text-[10px] text-fg-muted">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultCard({ event }: { event: SessionEventDTO }) {
  const [open, setOpen] = useState(false);
  const payload = p(event);
  const isError = event.type === "agent.tool_error" || payload["is_error"] === true;
  const content = payload["content"];
  return (
    <div className="py-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 text-[11px] ${isError ? "text-red-400" : "text-emerald-400"} hover:underline`}
      >
        {isError ? "Error" : "Result"}
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-x-auto rounded-md bg-bg-elevated p-2 text-[10px] text-fg-muted">
          {typeof content === "string"
            ? content
            : JSON.stringify(content, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function EventCard({
  event,
  verbose,
  onRespond,
  workspaceSlug,
  agentId,
  sessionId,
}: Props) {
  switch (event.type) {
    case "session.started":
    case "session.completed":
    case "session.failed":
      return <SessionBanner event={event} />;
    case "session.resumed":
      return <ResumedDivider />;
    case "user.message":
    case "user.input_response":
      return <UserBubble event={event} workspaceSlug={workspaceSlug} />;
    case "agent.text":
      return <AgentText event={event} />;
    case "agent.status":
      return <StatusCard event={event} />;
    case "agent.artifact":
      return <ArtifactCard event={event} />;
    case "agent.share":
      return (
        <SharePill
          event={event}
          workspaceSlug={workspaceSlug}
          sessionId={sessionId}
        />
      );
    case "agent.input_request":
      return <InputRequestCard event={event} onRespond={onRespond} />;
    case "agent.permission_request":
      return (
        <PermissionRequestCard
          event={event}
          onRespond={onRespond}
          workspaceSlug={workspaceSlug}
          agentId={agentId}
          sessionId={sessionId}
        />
      );
    case "agent.error":
      return <ErrorCard event={event} />;
    case "agent.thinking":
      return verbose ? <VerboseThinking event={event} /> : null;
    case "agent.tool_call":
      return <ToolCallCard event={event} />;
    case "agent.tool_result":
    case "agent.tool_error":
      return verbose ? <ToolResultCard event={event} /> : null;
    case "session.init":
      return verbose ? (
        <div className="py-1 text-[10px] text-fg-faint/70">
          session.init ({Array.isArray(p(event)["tools"]) ? (p(event)["tools"] as unknown[]).length : 0} tools available)
        </div>
      ) : null;
    default:
      return verbose ? (
        <div className="py-1 text-[10px] text-fg-faint/70">{event.type}</div>
      ) : null;
  }
}
