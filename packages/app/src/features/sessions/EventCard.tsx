import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { MermaidDiagram } from "./MermaidDiagram";
import { SharePill } from "./SharePill";
import { markdownComponents } from "./markdown-components";
import { Button } from "../../components/ui/button";
import { apiFetch } from "../../lib/api";

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
const WAKE_KIND_LABELS: Record<string, { label: string; tint: string }> = {
  state_change: { label: "child finished", tint: "border-blue-700/60 bg-blue-950/40" },
  heartbeat: { label: "scheduler heartbeat", tint: "border-purple-700/60 bg-purple-950/40" },
  watchdog: { label: "watchdog — silent child", tint: "border-amber-700/60 bg-amber-950/40" },
  checkup: { label: "platform checkup", tint: "border-border-strong/60 bg-bg-elevated/60" },
  message: { label: "message from child", tint: "border-emerald-700/60 bg-emerald-950/40" },
};

/**
 * Platform wakes (scheduler heartbeats, watchdog pings, child
 * state-change notifications, etc.) carry the same shape as a
 * human-typed user message but are pure platform noise from an
 * operator's perspective — they shouldn't dominate the timeline.
 * Render them as a tiny one-line pill that expands on click to show
 * the full payload. Default state is collapsed; mirrors the
 * `ToolGroupPill` / `ToolCallCard` pattern already used elsewhere in
 * the timeline so we don't introduce new design tokens.
 */
function PlatformWakePill({
  event,
  label,
  tint,
}: {
  event: SessionEventDTO;
  label: string;
  tint: string;
}) {
  const [open, setOpen] = useState(false);
  const payload = p(event);
  const fromSessionId = payload["from_session_id"] as string | undefined;
  const fromAgent = payload["from_agent_slug"] as string | undefined;
  const driverless = payload["driverless"] === true;
  const text = String(payload["text"] ?? "");
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-soft px-2 py-1 text-[11px] text-fg-muted hover:border-border-strong hover:text-fg"
      >
        <Icon className="size-3" />
        <span className="rounded bg-bg-muted px-1.5 py-0.5 font-medium text-fg">
          {driverless ? "scheduler wake" : "platform wake"}
        </span>
        <span>{label}</span>
        <span className="text-fg-faint">· {time}</span>
      </button>
      {open && (
        <div className={`mt-1 rounded-md border ${tint} px-3 py-2 text-xs`}>
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-fg-muted">
            <span>{label}</span>
            {driverless && (
              <span className="text-fg-faint">· driverless</span>
            )}
            {fromSessionId && (
              <span className="text-fg-faint">
                · from {String(fromSessionId).slice(0, 8)}
                {fromAgent ? ` (${fromAgent})` : ""}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap text-fg">{text}</p>
        </div>
      )}
    </div>
  );
}

function UserBubble({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  const fromSessionId = payload["from_session_id"] as string | undefined;
  const fromAgent = payload["from_agent_slug"] as string | undefined;
  const source = payload["source"] as string | undefined;
  const kind = payload["kind"] as string | undefined;

  // Platform-originated wake: collapse to a pill so server-driven
  // heartbeats and child state-change notifications don't look like
  // multi-paragraph human messages cluttering the timeline. The full
  // payload is one click away.
  if (source === "platform" && kind && WAKE_KIND_LABELS[kind]) {
    const { label, tint } = WAKE_KIND_LABELS[kind];
    return <PlatformWakePill event={event} label={label} tint={tint} />;
  }

  // User turns: subtle right-aligned bubble. Light tint distinguishes
  // from the agent's flat prose without the heavy chat-app shape we
  // used to have. Matches the Zapier reference (Image 7).
  return (
    <div className="flex justify-end py-3">
      <div className="max-w-[80%] rounded-2xl bg-bg-elevated/70 px-4 py-2.5 text-[15px] leading-7 text-fg">
        <p className="whitespace-pre-wrap">{String(payload["text"] ?? "")}</p>
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
      return <UserBubble event={event} />;
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
