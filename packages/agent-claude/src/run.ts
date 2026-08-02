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
import { resolveImageTokens as resolveImageTokensImpl } from "../../agent-runtime/src/image-tokens.js";
import { createInputChannel } from "./input-channel.js";
import { IdleTimer } from "../../agent-runtime/src/idle-timer.js";
import {
  buildAgentThinkingCancelledEvent,
  buildAgentThinkingEvent,
  type WakeEnvelopeFields,
} from "../../agent-runtime/src/wake-classifier.js";
import { createEventCorrelator } from "../../agent-runtime/src/event-correlator.js";

// ── Config ───────────────────────────────────────────────

const sessionId = process.env.SESSION_ID;
const agentId = process.env.AGENT_ID || "generic";
const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";
// The sidecar splits credentials (127.0.0.1:9090) from health (0.0.0.0:9091)
// — see packages/sidecar/src/main.rs. The /health route lives only on :9091.
const sidecarHealthUrl =
  process.env.SIDECAR_HEALTH_URL || "http://localhost:9091";
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

// Poll the sidecar's /health until it answers or we hit the timeout.
// The sidecar performs git clones + NATS connect before binding its
// listeners, so it routinely takes 1-3s longer than the agent to be
// ready. Without this gate the early POSTs (session.started + the
// gh-credential bootstrap) race the sidecar's HTTP listener and silently
// no-op, leaving `gh` unauthenticated and the session.started event lost.
async function waitForSidecar(timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  let delay = 100;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${sidecarHealthUrl}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1000);
  }
  return false;
}

// ── SSE stream on :3100 ─────────────────────────────────

const eventBuffer: unknown[] = [];
const listeners = new Set<(event: unknown) => void>();

/**
 * X1A-103: track the most recent wake's event_id so we can stamp it
 * onto the first agent emission for that wake. The frontend uses the
 * stamped id to deterministically clear the matching agent_thinking
 * indicator. State machine logic lives in event-correlator.ts so it's
 * unit-testable without a running agent process.
 */
const correlator = createEventCorrelator();

function emitToStream(event: { type: string; payload: unknown }) {
  correlator.maybeStamp(event);
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

/**
 * X1A-103 transient events: pushed to the SSE stream like any other
 * event, but the api subscriber's persistence skip-list drops them on
 * the floor (see packages/api/src/nats/subscriber.ts) so they never
 * land in `session_events`. Goes through the buffer so a wake that
 * hits /inject before the sidecar's stream consumer has connected
 * still has its agent_thinking delivered on first connect.
 *
 * Distinct from emitToStream because:
 *   1. Idle-timer is NOT reset (this event is informational, not work).
 *   2. event_id stamping is skipped (the payload already carries it).
 */
function emitTransient(event: { type: string; payload: unknown }) {
  eventBuffer.push(event);
  if (eventBuffer.length > 1000) eventBuffer.shift();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore — same close-race tolerance as emitToStream.
    }
  }
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

// ── Wait for the sidecar before any POST/GET to it ─────

// `session.started` immediately after the system-prompt block needs the
// sidecar's :9090 to be listening. The sidecar's startup includes git
// clones + NATS connect before the HTTP listener binds, so it lands
// later than the agent on most starts.
//
// `gh` and `git` no longer need a bootstrap here — both go through
// shims (/usr/local/bin/gh, /usr/local/bin/git-credential-x1) that hit
// the sidecar per call, so a stale long-lived token can't accumulate.
const sidecarReady = await waitForSidecar();
if (!sidecarReady) {
  console.warn(
    "[agent] sidecar did not become ready within 30s — session.started may be lost",
  );
}

// ── MCP servers ─────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedRuntimeDir = path.resolve(here, "../../agent-runtime/src");
const x1McpPath = path.resolve(sharedRuntimeDir, "x1-mcp.ts");
const filesMcpPath = path.resolve(sharedRuntimeDir, "files-mcp.ts");
const sheetsMcpPath = path.resolve(sharedRuntimeDir, "sheets-mcp.ts");
const docsMcpPath = path.resolve(sharedRuntimeDir, "docs-mcp.ts");
const calendarMcpPath = path.resolve(sharedRuntimeDir, "calendar-mcp.ts");
const emailMcpPath = path.resolve(sharedRuntimeDir, "email-mcp.ts");

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

type StdioMcp = {
  command: string;
  args: string[];
  env: Record<string, string>;
};
type HttpMcp = { type: "http"; url: string };
type RemoteAttachmentEnv = { name: string; url: string };

const mcpServers: Record<string, StdioMcp | HttpMcp> = {
  x1agent: {
    command: tsxPath,
    args: [x1McpPath],
    env: { SIDECAR_URL: sidecarUrl },
  },
  // `files` provider tools (list / get / download). Always registered;
  // returns permission_required at call time when the user hasn't
  // connected Google Drive. The agent decides whether to advertise the
  // tool to the LLM (we always do — discovery > silence).
  files: {
    command: tsxPath,
    args: [filesMcpPath],
    env: { SIDECAR_URL: sidecarUrl },
  },
  // Google Workspace surfaces — Sheets / Docs / Calendar / Gmail.
  // Always registered; permission_required surfaces at call time
  // when the user hasn't granted the matching scope.
  sheets: {
    command: tsxPath,
    args: [sheetsMcpPath],
    env: { SIDECAR_URL: sidecarUrl },
  },
  docs: {
    command: tsxPath,
    args: [docsMcpPath],
    env: { SIDECAR_URL: sidecarUrl },
  },
  calendar: {
    command: tsxPath,
    args: [calendarMcpPath],
    env: { SIDECAR_URL: sidecarUrl },
  },
  email: {
    command: tsxPath,
    args: [emailMcpPath],
    env: { SIDECAR_URL: sidecarUrl },
  },
};

// Zone-3 remote_oauth MCPs. The api resolves the active user's
// bearer at session-launch and mounts it inside the per-attachment
// proxy sibling container; here we just point the SDK at the
// localhost URL the proxy listens on. No bearer in the agent
// process — that's the whole point of the proxy.
const remoteMcpJson = process.env.MCP_REMOTE_ATTACHMENTS_JSON;
if (remoteMcpJson) {
  try {
    const parsed = JSON.parse(remoteMcpJson) as RemoteAttachmentEnv[];
    for (const r of parsed) {
      if (typeof r.name !== "string" || typeof r.url !== "string") continue;
      mcpServers[r.name] = { type: "http", url: r.url };
      console.log(
        `[agent] zone-3 mcp ${r.name} → ${r.url} (bearer held by sibling proxy)`,
      );
    }
  } catch (err) {
    console.warn(
      `[agent] MCP_REMOTE_ATTACHMENTS_JSON parse failed: ${(err as Error).message}`,
    );
  }
}

const allowedTools = [
  "mcp__x1agent__emit_status",
  "mcp__x1agent__emit_artifact",
  "mcp__x1agent__request_input",
  "mcp__x1agent__emit_error",
  "mcp__x1agent__share",
  "mcp__x1agent__request_permission",
  "mcp__x1agent__end_session",
  "mcp__files__list_files",
  "mcp__files__get_file",
  "mcp__files__download_file",
  "mcp__files__upload_file",
  "mcp__files__update_file_content",
  "mcp__files__update_file_metadata",
  "mcp__files__create_folder",
  "mcp__files__trash_file",
  "mcp__sheets__read_sheet_range",
  "mcp__sheets__update_sheet_range",
  "mcp__sheets__append_sheet_row",
  "mcp__sheets__create_spreadsheet",
  "mcp__docs__read_doc",
  "mcp__docs__create_doc",
  "mcp__docs__replace_text_in_doc",
  "mcp__docs__append_paragraph_to_doc",
  "mcp__calendar__list_calendar_events",
  "mcp__calendar__create_calendar_event",
  "mcp__calendar__update_calendar_event",
  "mcp__calendar__delete_calendar_event",
  "mcp__email__list_email_threads",
  "mcp__email__get_email_message",
  "mcp__email__send_email",
  "mcp__email__trash_email",
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

const agentKind = process.env.AGENT_KIND ?? "worker";
const isOrchestrator = agentKind === "orchestrator";

// `share` is the user-facing artifact tool. Orchestrators have a human
// watching them and routinely ship deliverables, so they get the full
// share guidance. Workers are driven by the orchestrator — their
// /workspace gets pulled via pull_from_child — and historically the
// "you MUST call share" pressure caused small models (Haiku) to
// narrate calling share without emitting the actual tool call, then
// claim the user could see files that were still stuck in the
// ephemeral pod. So workers don't get share guidance at all.
const shareBullet = isOrchestrator
  ? `- **share**: Persist a /workspace file for the user — the user cannot see your /workspace, so a file is invisible until you \`share\` it. Use \`share\` for every substantive deliverable: report, site, dataset, deck, exported file. Write the file, then call share on the path. Renders inline (HTML, image, SVG, CSV, JSON, Markdown, code, ZIP) and lists on the Shares page. **Prefer updating an existing share over creating v2/v3.** When iterating on an artifact, pass the existing \`share_id\` so the same pill updates in place and any comment thread stays attached — never publish a fresh share for the next revision.`
  : ``;

const orchestratorSection = isOrchestrator
  ? `

## You Are an Orchestrator

You can spawn child sessions (workers) and drive them. Each child runs in its own pod with its own private \`/workspace\` — you can NOT see their files directly, and they can NOT push files to you.

**Default mechanism for getting a worker's output into your workspace:** the **\`pull_from_child\`** tool. It snapshots the worker's entire \`/workspace\` into your own \`/workspace/workers/<child_session_id>/\`. After it returns, use Read / Bash / Grep against \`/workspace/workers/<id>/\` as if those files were always yours. Call it whenever you need their output — after the worker reports done, mid-flight to check progress, or after \`inject_message\` if you asked them to produce something. A second call overwrites with a fresh snapshot.

Other orchestrator-only tools:
- **\`spawn_session\`**: start a child worker (use \`list_spawnable_agents\` to discover which agents you can spawn).
- **\`inject_message\`**: send a user-message turn into a running child.
- **\`cancel_session\`**: stop a child you spawned.
- **\`share_to_child\`**: push a file or folder from your \`/workspace\` into a child's \`/workspace\` (inverse of \`pull_from_child\`).
- **\`read_child_output\`**: read a child's event timeline (status updates, artifacts, errors) — events only, not files.

The workspace mental model: each child's \`/workspace\` is sandboxed. The only way data flows out of it is \`pull_from_child\`. The only way data flows in is \`share_to_child\` or what you put in the initial prompt.`
  : `

## You Are a Worker

You're running in a pod spawned by an orchestrator. Your \`/workspace\` is PRIVATE to this session. The orchestrator pulls files from your workspace when it needs them (\`pull_from_child\`); you don't push.

So: just write your output to \`/workspace\` like any normal working directory and let the orchestrator pull it.`;

// Worker-facing guidelines drop the share-related bullet since workers
// don't have share in their tool list; the orchestrator handles that
// for them.
const guidelinesShareBullet = isOrchestrator
  ? `\n- For any "share X" / "build Y" / "give me Z" request, write to /workspace and \`share\`. When revising an artifact the user has already seen, update the existing share by id — don't create a new one. \`emit_artifact\` is for throwaway inline content only.`
  : ``;

const systemPromptText = `${workspacePromptSection}${identityLine} You are running as an agent and a user is watching your session in real-time.

## Communication Tools

- **emit_status**: Start of each distinct phase of work.
- **emit_artifact**: Inline Markdown / code in the event stream. Ephemeral.${shareBullet ? "\n" + shareBullet : ""}
- **request_input**: Ask the user a question with clickable options.
- **emit_error**: Report a problem.
- **request_permission**: Ask for a scope the user hasn't granted.
- **end_session**: Task is definitively done.${interactivePrompt}

## Reading files the user uploaded (X1A-96)

When the user attaches a file to their prompt, the platform writes the bytes to disk at \`/workspace/.x1/uploads/<uuid>.<ext>\` BEFORE the message reaches you. Your inbound message text will name that path inline, e.g.:

  (user attached file: /workspace/.x1/uploads/7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11.png — use the Read tool to view it)

Use the **Read** tool on that path. For images (PNG, JPG, GIF, WebP) Read returns the file as visual content blocks so you can actually see the picture. For PDFs and text files Read returns the content as text. Don't shell out to \`curl\` or \`cat\` — Read handles every type correctly and is the only path that lets you see image contents.

If the message says \`(upload <id>: unavailable)\` or \`(upload <id>: error)\` instead of a file path, the file couldn't be fetched — ask the user to re-attach. Don't fabricate what you think the file contains.

## Guidelines

- Call \`emit_status\` at the start of each phase.${guidelinesShareBullet}
- Be responsive — the user is watching live.${orchestratorSection}`;

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
    settingSources: ["user", "project"],
    skills: "all",
    permissionMode: "bypassPermissions",
    ...(process.env.CLAUDE_PATH
      ? { pathToClaudeCodeExecutable: process.env.CLAUDE_PATH }
      : {}),
  },
});

// ── Inject endpoint on :8788 ───────────────────────────

/**
 * X1A-96: expand `[image: <uuid>]` tokens in a user message into real
 * files on disk so the LLM can `Read` them. After the t02/t05 P0 fix
 * the agent container no longer holds the api's master internal
 * token — bytes come through the sidecar's `/uploads/read`
 * credential proxy. Logic lives in `image-tokens.ts` so it's
 * unit-testable without booting this file's HTTP servers.
 */
function resolveImageTokens(text: string): Promise<string> {
  return resolveImageTokensImpl(text, { sidecarUrl });
}

const injectServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/inject" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body) as {
        text?: string;
        request_id?: string;
        // X1A-103: optional wake-classification fields the sidecar
        // forwards from the NATS envelope. Older sidecars omit these
        // — buildAgentThinkingEvent treats absent fields as "user wake
        // with a fresh event_id" so the indicator still fires.
        event_id?: string;
        wake_source?: string;
        share_id?: string | null;
        thread_id?: string | null;
        kind?: string;
        source?: string;
        // X1A-133 (PRD 0007) — SDK-native wake envelope. `origin.kind`
        // discriminates the wake category; share-comment wakes carry
        // `origin: { kind: 'channel', server: 'share-comments' }` and
        // are NOT persisted in the session timeline (they live in the
        // share's comment thread). `is_synthetic` flags server-driven
        // wakes; `priority` / `should_query` are forward-compatible.
        origin?: {
          kind?: string;
          server?: string;
          share_id?: string | null;
          thread_id?: string | null;
        } | null;
        is_synthetic?: boolean;
        priority?: string;
        should_query?: boolean;
      };
      if (typeof parsed.text !== "string") {
        res.writeHead(400);
        res.end("text required");
        return;
      }
      // X1A-103: emit the agent_thinking indicator BEFORE pushing the
      // wake into the SDK so the UI shows the indicator the instant
      // the pod receives the wake — not after the LLM call returns.
      const wakeFields: WakeEnvelopeFields = {
        event_id: parsed.event_id ?? null,
        wake_source: parsed.wake_source ?? null,
        share_id: parsed.share_id ?? null,
        thread_id: parsed.thread_id ?? null,
        kind: parsed.kind ?? null,
        source: parsed.source ?? null,
        request_id: parsed.request_id ?? null,
      };
      const thinking = buildAgentThinkingEvent(sessionId!, wakeFields);
      correlator.arm(thinking.event_id);
      emitTransient({ type: thinking.type, payload: thinking });

      // X1A-96: rewrite any `[image: <uuid>]` tokens into "(user attached
      // file: /workspace/.x1/uploads/<id>.<ext>)" before the LLM sees
      // the message. The Read tool on the resulting path returns image
      // content to Claude so the model literally sees the pixels.
      const resolvedText = await resolveImageTokens(parsed.text);
      inputChannel.push(resolvedText, parsed.request_id || undefined);
      // X1A-133 — share-comment wakes belong in the share's comment
      // thread, not in the session timeline. Skip the .events emit
      // when origin.kind === 'channel' && origin.server ===
      // 'share-comments' so the user.message never reaches durable
      // session_events. The agent still processes the wake (already
      // pushed to inputChannel above); it just doesn't pollute the
      // main timeline. Other origin.kind values reserved for future
      // PRD 0007 slices (peer / coordinator / task-notification)
      // fall through to the normal emit so the contract is opt-in.
      const isShareCommentChannel =
        parsed.origin?.kind === "channel" &&
        parsed.origin?.server === "share-comments";
      if (!isShareCommentChannel) {
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
      }
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
  // X1A-103 ghost-indicator safety: if a wake's agent_thinking was
  // emitted but no agent response stamped its event_id back yet, the
  // browser still has the indicator pinned. Emit a cancellation so it
  // clears immediately on graceful shutdown / end_session / idle
  // timeout. (X1A-104 also applies a 60s client TTL as a backstop —
  // this is the best-effort server-side fast path.)
  const orphanedWakeId = correlator.pending();
  if (orphanedWakeId) {
    correlator.clear();
    emitTransient({
      type: "session.agent_thinking_cancelled",
      payload: buildAgentThinkingCancelledEvent(
        sessionId!,
        orphanedWakeId,
        "graceful_shutdown",
      ),
    });
    // Give the SSE stream a beat to flush before we tear down. The
    // sidecar polls bytes from the stream and republishes; the
    // existing 500ms wait below covers NATS but not the SSE hop.
    await new Promise((r) => setTimeout(r, 50));
  }
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
