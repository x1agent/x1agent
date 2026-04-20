import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { MermaidDiagram } from "./MermaidDiagram";
import ShareCard from "./ShareCard";
import { Badge } from "../../components/ui/badge";
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

function UserBubble({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  const fromSessionId = payload["from_session_id"] as string | undefined;
  const fromAgent = payload["from_agent_slug"] as string | undefined;
  return (
    <div className="flex justify-end px-4 py-3">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-zinc-800 px-4 py-2 text-sm text-zinc-100">
        <p className="whitespace-pre-wrap">{String(payload["text"] ?? "")}</p>
        {fromSessionId && (
          <div className="mt-1 text-[10px] text-zinc-400">
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
    <div className="px-4 py-3 text-sm">
      <div className="prose prose-sm prose-invert max-w-none [&_pre]:overflow-x-auto">
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
    </div>
  );
}

function ResumedDivider() {
  return (
    <div className="my-2 flex items-center gap-3 px-4 py-3">
      <div className="flex-1 border-t border-dashed border-zinc-800" />
      <span className="px-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        Session resumed
      </span>
      <div className="flex-1 border-t border-dashed border-zinc-800" />
    </div>
  );
}

function SessionBanner({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  const type = event.type;
  let label = "Session started";
  let color = "text-emerald-400 bg-emerald-950/40";
  if (type === "session.completed") {
    label = `Session completed${typeof payload["result"] === "string" && payload["result"].includes("inactivity") ? " (idle timeout)" : ""}`;
  } else if (type === "session.failed") {
    label = `Session failed${payload["error"] ? `: ${String(payload["error"])}` : ""}`;
    color = "text-red-400 bg-red-950/40";
  }
  return (
    <div
      className={`flex items-center justify-between px-4 py-2 text-xs font-medium ${color}`}
    >
      <span>{label}</span>
      <span className="text-[10px] opacity-60">
        {new Date(event.timestamp).toLocaleTimeString()}
      </span>
    </div>
  );
}

function StatusCard({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-xs text-zinc-500">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
      <span className="capitalize">{String(payload["status"] ?? "")}</span>
      {payload["detail"] && (
        <span className="text-zinc-400">— {String(payload["detail"])}</span>
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
    <div className="px-4 py-3">
      <div className="rounded-lg border border-zinc-800 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
            {mermaid ? "diagram" : kind}
          </span>
          <span className="text-sm font-medium text-zinc-100">{title}</span>
        </div>
        {mermaid ? (
          <MermaidDiagram content={content} />
        ) : isCode ? (
          <pre className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100">
            {content}
          </pre>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        )}
      </div>
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
    <div className="px-4 py-3">
      <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3">
        <p className="mb-2 text-sm text-amber-200">
          {String(payload["question"] ?? "The agent has a question.")}
        </p>
        {options.length > 0 && onRespond && (
          <div className="flex flex-wrap gap-2">
            {options.map((opt) => (
              <button
                key={opt}
                onClick={() => onRespond(opt, requestId)}
                className="rounded-md border border-amber-700 bg-zinc-900 px-3 py-1 text-sm text-zinc-100 hover:bg-amber-950/40"
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
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
    <div className="px-4 py-3">
      <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-amber-300">
            Permission request
          </span>
          <Badge variant="warning">{grantType}</Badge>
          <Badge variant="secondary">{scope}</Badge>
        </div>
        <p className="mb-2 text-sm text-amber-100">
          The agent is asking for{" "}
          <span className="font-medium">{summarize()}</span>.
        </p>
        {justification && (
          <p className="mb-3 whitespace-pre-wrap text-sm text-zinc-200">
            {justification}
          </p>
        )}
        {state === "error" && error && (
          <p className="mb-2 text-xs text-red-400">{error}</p>
        )}
        {state === "pending" || state === "approving" || state === "error" ? (
          <div className="flex gap-2">
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
          <p className="text-xs text-zinc-500">
            {state === "approved" ? "Approved." : "Denied."}
          </p>
        )}
      </div>
    </div>
  );
}

function ErrorCard({ event }: { event: SessionEventDTO }) {
  const payload = p(event);
  return (
    <div className="px-4 py-2 text-sm text-red-400">
      <span>{String(payload["message"] ?? "")}</span>
      {payload["recoverable"] === true && (
        <span className="ml-2 text-xs text-zinc-500">(continuing)</span>
      )}
    </div>
  );
}

function VerboseThinking({ event }: { event: SessionEventDTO }) {
  const [open, setOpen] = useState(false);
  const text = String(p(event)["text"] ?? "");
  if (!text) return null;
  return (
    <div className="px-4 py-1">
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
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-purple-900 pl-3 text-xs text-zinc-400">
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
    <div className="px-4 py-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[10px]">
          {name}
        </span>
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <pre className="mt-1 overflow-x-auto rounded-md bg-zinc-900 p-2 text-[10px] text-zinc-300">
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
    <div className="px-4 py-1.5">
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
        <pre className="mt-1 max-h-64 overflow-x-auto rounded-md bg-zinc-900 p-2 text-[10px] text-zinc-300">
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
        <ShareCard
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
        <div className="px-4 py-1 text-[10px] text-zinc-600">
          session.init ({Array.isArray(p(event)["tools"]) ? (p(event)["tools"] as unknown[]).length : 0} tools available)
        </div>
      ) : null;
    default:
      return verbose ? (
        <div className="px-4 py-1 text-[10px] text-zinc-600">{event.type}</div>
      ) : null;
  }
}
