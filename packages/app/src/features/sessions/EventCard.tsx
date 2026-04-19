import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";
import type { SessionEventDTO } from "@x1agent/shared";
import { MermaidDiagram } from "./MermaidDiagram";

interface Props {
  event: SessionEventDTO;
  verbose?: boolean;
  onRespond?: (text: string, requestId: string) => void;
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

function ToolCallCard({ event }: { event: SessionEventDTO }) {
  const [open, setOpen] = useState(false);
  const payload = p(event);
  const name = String(payload["tool_name"] ?? "tool");
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

export function EventCard({ event, verbose, onRespond }: Props) {
  switch (event.type) {
    case "session.started":
    case "session.completed":
    case "session.failed":
      return <SessionBanner event={event} />;
    case "user.message":
    case "user.input_response":
      return <UserBubble event={event} />;
    case "agent.text":
      return <AgentText event={event} />;
    case "agent.status":
      return <StatusCard event={event} />;
    case "agent.artifact":
      return <ArtifactCard event={event} />;
    case "agent.input_request":
      return <InputRequestCard event={event} onRespond={onRespond} />;
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
