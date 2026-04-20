/**
 * Agent container entrypoint.
 *
 * Responsibilities:
 *   - SSE stream on :3100 — the sidecar consumes this and publishes each
 *     event to NATS as `x1.session.{id}.events`.
 *   - HTTP inject endpoint on :8788 — the sidecar POSTs here with user
 *     messages arriving from the browser (via NATS), which we push into
 *     the Claude Agent SDK's AsyncIterable prompt.
 *   - Idle shutdown — `/keepalive` from the sidecar (browser presence)
 *     resets the timer; a busy watchdog covers long tool calls.
 *
 * Session modes:
 *   - "interactive" (default): stays alive between turns, shuts down on
 *     idle timeout or end_session.
 *   - "oneshot": exits after the first result message.
 */
import {
  query,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeMessage } from "./normalize.js";
import { createInputChannel } from "./input-channel.js";
import { IdleTimer } from "./idle-timer.js";

// ── Config ───────────────────────────────────────────────

const sessionId = process.env.SESSION_ID;
const agentId = process.env.AGENT_ID || "generic";
const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";
const maxTurns = Number.parseInt(process.env.MAX_TURNS || "200", 10);
// Empty = no auto-prompt; the SDK blocks on the input channel until the
// user's first inject arrives. Scheduler-triggered sessions populate
// this with the agent's heartbeat_md; user-triggered sessions leave it
// empty so the browser's MessageInput drives the first turn.
const prompt = process.env.AGENT_PROMPT || "";
const sessionMode = process.env.SESSION_MODE || "interactive";
const idleTimeoutMs = Number.parseInt(
  process.env.IDLE_TIMEOUT_MS || "900000",
  10,
);
const platformName = process.env.PLATFORM_NAME || "x1agent";
const workspaceName = process.env.WORKSPACE_NAME || "";
const workspaceSystemPrompt = process.env.WORKSPACE_SYSTEM_PROMPT || "";

if (!sessionId) {
  console.error("[agent] SESSION_ID is required");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────

async function postToSidecar(type: string, payload: unknown): Promise<void> {
  try {
    await fetch(`${sidecarUrl}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
  } catch (err) {
    console.error(`[agent] sidecar POST failed: ${(err as Error).message}`);
  }
}

// ── SSE stream on :3100 ─────────────────────────────────

const eventBuffer: unknown[] = [];
const listeners = new Set<(event: unknown) => void>();

function emitToStream(event: unknown) {
  eventBuffer.push(event);
  if (eventBuffer.length > 1000) eventBuffer.shift();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // listener removal on close handled below; nothing else to do.
    }
  }
  // Any agent output (text, tool call, result) keeps the session alive.
  resetIdleTimer();
}

const streamServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const e of eventBuffer) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const listener = (event: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // write races with close; next loop sees closed socket.
      }
    };
    listeners.add(listener);
    req.on("close", () => listeners.delete(listener));
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

streamServer.listen(3100, "0.0.0.0", () => {
  console.log("[agent] SSE stream listening on :3100");
});

// ── Input channel → SDK ─────────────────────────────────

const inputChannel = createInputChannel();
// Only seed the initial prompt when one was configured (scheduler
// sessions, mostly). User-triggered sessions leave this empty — the
// SDK will block on the channel until the browser injects a message.
if (prompt) {
  // Queue a synthetic user.message event for the stream so the session
  // detail UI shows what the agent was asked. The SDK doesn't emit a
  // wire event when we feed its input iterator, so without this the
  // scheduler-triggered runs open on "agent.text" with no context for
  // what it's responding to. We push to the buffer directly rather
  // than via emitToStream — at this point in module init the idle
  // timer doesn't exist yet, and the sidecar isn't connected either,
  // so the listener-notify + idle-reset paths inside emitToStream
  // would either no-op or throw. The sidecar will pick this up on its
  // first SSE-stream connection via the buffer replay.
  eventBuffer.push({
    type: "user.message",
    payload: { text: prompt },
  });
  inputChannel.push(prompt);
}

// ── Sidecar credential bootstrap for gh CLI ────────────

// The sidecar exposes /git/credential — pull a token once at startup so
// the `gh` CLI works inside the container. Subsequent `git` calls go
// through the credential helper on every request.
try {
  const credResp = await fetch(`${sidecarUrl}/git/credential?format=token`);
  if (credResp.ok) {
    const body = (await credResp.json()) as { token?: string };
    if (body.token) {
      process.env.GH_TOKEN = body.token;
      console.log("[agent] gh CLI configured via sidecar credential");
    }
  }
} catch {
  // No credential configured — gh still works for public repos.
}

// ── MCP servers ─────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const x1McpPath = path.resolve(here, "x1-mcp.ts");

// Resolve tsx so spawned MCP subprocesses can find it whether we're in
// a container (tsx on PATH) or local dev (node_modules/.bin/tsx).
function resolveTsxBinary(): string {
  const candidates = [
    path.resolve(here, "../../../node_modules/.bin/tsx"),
    path.resolve(here, "../../node_modules/.bin/tsx"),
    path.resolve(here, "../node_modules/.bin/tsx"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "tsx";
}
const tsxPath = resolveTsxBinary();
console.log(`[agent] tsx binary: ${tsxPath}`);

const mcpServers: Record<string, {
  command: string;
  args: string[];
  env: Record<string, string>;
}> = {
  x1agent: {
    command: tsxPath,
    args: [x1McpPath],
    env: { SIDECAR_URL: sidecarUrl },
  },
};

const allowedTools = [
  "mcp__x1agent__emit_status",
  "mcp__x1agent__emit_artifact",
  "mcp__x1agent__request_input",
  "mcp__x1agent__emit_error",
  "mcp__x1agent__share",
  "mcp__x1agent__request_permission",
  "mcp__x1agent__end_session",
];

// ── System prompt ───────────────────────────────────────

const identityLine = workspaceName
  ? `You are ${platformName}, an AI assistant for ${workspaceName}.`
  : `You are ${platformName}, an AI assistant.`;

const workspacePromptSection = workspaceSystemPrompt
  ? `\n## Workspace Instructions\n\n${workspaceSystemPrompt}\n\n---\n`
  : "";

const interactivePrompt =
  sessionMode === "interactive"
    ? `\n\n## Interactive Session\n\nThis is an INTERACTIVE session. The user will send you multiple messages over time. After responding to each message, STOP and WAIT for the next user message. Do NOT say goodbye or end the conversation.`
    : `\n\n## One-Shot Session\n\nComplete the task and finish.`;

const systemPromptText = `${workspacePromptSection}${identityLine} You are running as an agent and a user is watching your session in real-time.

## Communication Tools

- **emit_status**: Call at the start of each distinct phase of work.
- **emit_artifact**: Call to share code, analysis, diagrams, or any output.
- **request_input**: Call to ask the user a question with clickable options.
- **emit_error**: Call to report problems.
- **share**: Call to publish a /workspace file (HTML, image, CSV, JSON, zip, code).
- **request_permission**: Call when you need a scope the user hasn't granted.
- **end_session**: Call when the task is definitively done.${interactivePrompt}

## Guidelines

- Call emit_status at the start of each phase.
- Use emit_artifact or share for any substantial output.
- Be responsive to user messages — the user is watching live.`;

// ── Start the conversation ──────────────────────────────

await postToSidecar("session.started", {
  agent_id: agentId,
  session_id: sessionId,
});
console.log(`[agent] starting ${sessionMode} session ${sessionId}`);

const conversation: Query = query({
  prompt: inputChannel as AsyncIterable<SDKUserMessage>,
  options: {
    cwd: process.env.WORKSPACE_DIR || "/workspace",
    maxTurns,
    systemPrompt: systemPromptText,
    mcpServers,
    allowedTools,
    permissionMode: "bypassPermissions",
    ...(process.env.CLAUDE_PATH
      ? { pathToClaudeCodeExecutable: process.env.CLAUDE_PATH }
      : {}),
  },
});

// ── Inject endpoint on :8788 ───────────────────────────

const injectServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/inject" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body) as {
        text?: string;
        request_id?: string;
      };
      if (typeof parsed.text !== "string") {
        res.writeHead(400);
        res.end("text required");
        return;
      }
      inputChannel.push(parsed.text, parsed.request_id || undefined);
      // Emit the user message to the stream so the sidecar publishes
      // it on `.events` and the api persists it to session_events. The
      // browser applies a local echo immediately on send, but without
      // this emission the event never reaches durable storage and
      // disappears on refresh.
      emitToStream({
        type: parsed.request_id ? "user.input_response" : "user.message",
        payload: parsed.request_id
          ? { text: parsed.text, request_id: parsed.request_id }
          : { text: parsed.text },
      });
      resetIdleTimer();
      console.log(`[agent] queued user message: ${parsed.text.slice(0, 100)}`);
      res.writeHead(200);
      res.end("ok");
    } catch (err) {
      res.writeHead(500);
      res.end((err as Error).message);
    }
  } else if (url.pathname === "/keepalive" && req.method === "POST") {
    // Sidecar forwards browser presence heartbeats — keep the session
    // alive while someone is watching, even without new messages.
    resetIdleTimer();
    res.writeHead(200);
    res.end("ok");
  } else if (url.pathname === "/shutdown" && req.method === "POST") {
    // Graceful shutdown path. Called by the x1agent MCP's end_session
    // tool. Respond immediately, then drive shutdown() asynchronously —
    // the response has to land before the process exits.
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: {
      summary?: string;
      is_success?: boolean;
      error?: string;
    } = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      // tolerate empty / malformed bodies
    }
    res.writeHead(200);
    res.end("ok");
    void shutdown(
      parsed.is_success !== false,
      parsed.summary ?? "Session ended by agent",
      parsed.error,
    );
  } else if (url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

injectServer.listen(8788, "0.0.0.0", () => {
  console.log("[agent] inject endpoint listening on :8788");
});

// ── Idle timeout ────────────────────────────────────────

let shuttingDown = false;

const idleTimer = new IdleTimer(idleTimeoutMs, sessionMode === "interactive", {
  onTimeout: () => {
    console.log(
      `[agent] idle timeout (${idleTimeoutMs / 1000}s) — closing session`,
    );
    void shutdown(true, "Session closed due to inactivity");
  },
});

function resetIdleTimer() {
  idleTimer.reset();
}

/**
 * Single, idempotent terminal path. Emits exactly one session.completed
 * (or session.failed) to the sidecar, gives NATS a moment to flush, and
 * kills the process. All callers — MCP end_session via /shutdown, idle
 * timeout, oneshot result — funnel through here so there is never a
 * double terminal event.
 */
async function shutdown(
  isSuccess: boolean,
  result?: unknown,
  error?: string,
): Promise<never> {
  if (shuttingDown) {
    // A second caller on the same path. Park forever; the first caller
    // will take the process down.
    await new Promise(() => {});
  }
  shuttingDown = true;
  idleTimer.dispose();
  await postToSidecar(isSuccess ? "session.completed" : "session.failed", {
    result,
    error,
  });
  await new Promise((r) => setTimeout(r, 500));
  streamServer.close();
  injectServer.close();
  process.exit(isSuccess ? 0 : 1);
}

// ── Main loop ───────────────────────────────────────────

resetIdleTimer();

for await (const message of conversation) {
  resetIdleTimer();

  // Turns hold the idle timer warm during long tool executions. A
  // result message flips busy back off.
  if (message.type === "assistant") {
    idleTimer.setBusy(true);
  }

  const normalized = normalizeMessage(message);
  if (normalized) {
    const events = Array.isArray(normalized) ? normalized : [normalized];
    for (const event of events) {
      emitToStream(event);

      // AskUserQuestion → surface as input_request so the UI can render
      // the question and collect an answer.
      if (
        event.type === "agent.tool_call" &&
        (event.payload as { tool_name?: string } | null)?.tool_name ===
          "AskUserQuestion"
      ) {
        const payload = event.payload as {
          input?: {
            question?: string;
            questions?: Array<{
              header?: string;
              options?: Array<string | { label?: string; value?: string }>;
            }>;
            options?: Array<string | { label?: string; value?: string }>;
          };
          tool_use_id?: string;
        };
        const firstQ = payload.input?.questions?.[0];
        const opts = firstQ?.options ?? payload.input?.options;
        emitToStream({
          type: "agent.input_request",
          payload: {
            question:
              firstQ?.header ||
              payload.input?.question ||
              "The agent has a question for you",
            options: opts?.map((o) =>
              typeof o === "string" ? o : (o.label ?? o.value ?? String(o)),
            ),
            request_id: payload.tool_use_id,
          },
        });
      }
    }
  }

  if (message.type === "result") {
    idleTimer.setBusy(false);

    if (sessionMode === "oneshot") {
      const subtype = (message as { subtype?: string }).subtype;
      const isSuccess = subtype === "success";
      await shutdown(
        isSuccess,
        isSuccess ? (message as { result?: unknown }).result : undefined,
        !isSuccess ? String(message) : undefined,
      );
      break;
    }

    // Interactive: the SDK pulls the next message from inputChannel,
    // which fills when the sidecar POSTs /inject.
    console.log("[agent] turn complete — waiting for next user message");
  }
}
