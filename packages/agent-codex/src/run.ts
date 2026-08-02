/**
 * Codex agent container entrypoint — spike v0.
 *
 * Parallel to packages/agent/src/run.ts (the Claude SDK harness). Differences:
 *
 *   - Agent loop driver: drives one long-lived `codex app-server --stdio`
 *     subprocess over JSON-RPC, preserving thread state across turns.
 *   - Event source: parses app-server JSONL notifications and translates
 *     them to platform wire shapes via normalize.ts.
 *   - Inject endpoint (:8788/inject) starts a real follow-up turn on the
 *     same Codex thread.
 *
 * The SSE :3100 contract, idle-timer, shutdown sequence, X1A-103
 * wake-classification, and sidecar /event POST are all identical to the
 * Claude harness — same downstream consumers (sidecar stream.rs → NATS →
 * api subscriber → browser), no changes required there.
 */
import http from "node:http";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { normalizeCodexNotification, type NormalizedEvent } from "./normalize.js";
import { CodexAppServer } from "./app-server.js";
import { IdleTimer } from "./idle-timer.js";
import {
  buildAgentThinkingCancelledEvent,
  buildAgentThinkingEvent,
  type WakeEnvelopeFields,
} from "./wake-classifier.js";
import { createEventCorrelator } from "./event-correlator.js";

// ── Config ───────────────────────────────────────────────

const sessionId = process.env.SESSION_ID;
const agentId = process.env.AGENT_ID || "generic";
const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";
const sidecarHealthUrl =
  process.env.SIDECAR_HEALTH_URL || "http://localhost:9091";
const prompt = process.env.AGENT_PROMPT || "";
const sessionMode = process.env.SESSION_MODE || "interactive";
const idleTimeoutMs = Number.parseInt(
  process.env.IDLE_TIMEOUT_MS || "900000",
  10,
);
const platformName = process.env.PLATFORM_NAME || "x1agent";
const workspaceName = process.env.WORKSPACE_NAME || "";
const workspaceSystemPrompt = process.env.WORKSPACE_SYSTEM_PROMPT || "";
const workspaceDir = process.env.WORKSPACE_DIR || "/workspace";
// The app-server discovers the account's default model when this is blank.
// OPENAI_MODEL remains an explicit per-agent/deployment override.
const codexModel = process.env.OPENAI_MODEL?.trim() || "";
// Bubblewrap inside an unprivileged pod is the open question
// (codex-spike-gap-analysis.md §6). The env knob lets the platform team
// flip the default per pod without rebuilding the image. Defaults to
// "workspace-write" (try the sandboxed path first); flip to
// "danger-full-access" via env if the pod's securityContext rejects
// the Bubblewrap setup. The pod is already the security boundary.
// The session pod is already the isolation boundary. Unprivileged k3s pods
// cannot reliably initialize Codex's workspace-write bubblewrap profile, so
// use the pod-scoped full-access mode by default; operators can still opt
// back into workspace-write with CODEX_SANDBOX.
const codexSandbox = process.env.CODEX_SANDBOX || "danger-full-access";
const codexBin = process.env.CODEX_PATH || "codex";

if (!sessionId) {
  console.error("[agent-codex] SESSION_ID is required");
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
    console.error(
      `[agent-codex] sidecar POST failed: ${(err as Error).message}`,
    );
  }
}

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
  resetIdleTimer();
}

function emitTransient(event: { type: string; payload: unknown }) {
  eventBuffer.push(event);
  if (eventBuffer.length > 1000) eventBuffer.shift();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore — same close-race tolerance as the Claude harness.
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
  console.log("[agent-codex] SSE stream listening on :3100");
});

// ── Wait for the sidecar ────────────────────────────────

const sidecarReady = await waitForSidecar();
if (!sidecarReady) {
  console.warn(
    "[agent-codex] sidecar did not become ready within 30s — session.started may be lost",
  );
}

// ── ~/.codex/config.toml — mount the x1agent MCP ────────

const here = path.dirname(fileURLToPath(import.meta.url));
const x1McpPath = path.resolve(here, "x1-mcp.ts");

function resolveTsxBinary(): string {
  const candidates = [
    path.resolve(here, "../../../node_modules/.bin/tsx"),
    path.resolve(here, "../../node_modules/.bin/tsx"),
    path.resolve(here, "../node_modules/.bin/tsx"),
    "/usr/local/bin/tsx",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "tsx";
}
const tsxPath = resolveTsxBinary();

function renderCodexConfig(): string {
  // Codex reads ~/.codex/config.toml on every `codex exec` invocation.
  // Mount the x1agent MCP as a stdio subprocess of Codex — exactly the
  // same surface the Claude harness gives Claude. Sidecar URL is passed
  // through env so the MCP knows where to POST events.
  const sidecarEnv = sidecarUrl.replace(/"/g, '\\"');
  const cmd = tsxPath.replace(/"/g, '\\"');
  const arg = x1McpPath.replace(/"/g, '\\"');
  return `# Auto-generated at pod boot by packages/agent-codex/src/run.ts.
# Do not edit; the file is rewritten on every container start.

[mcp_servers.x1agent]
command = "${cmd}"
args = ["${arg}"]
env = { SIDECAR_URL = "${sidecarEnv}" }
`;
}

function writeCodexConfig(): string {
  const home = process.env.HOME || os.homedir();
  const dir = path.join(home, ".codex");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; codex will error loudly downstream if the dir is
    // unwritable.
  }
  const filePath = path.join(dir, "config.toml");
  writeFileSync(filePath, renderCodexConfig(), "utf8");
  console.log(`[agent-codex] wrote ${filePath}`);
  return filePath;
}

writeCodexConfig();

function writeCodexInstructions(text: string): string {
  // Codex auto-discovers ~/.codex/AGENTS.md as persistent system
  // instructions on every `codex exec` invocation. Writing here
  // sidesteps the question of which CLI flag carries instructions
  // (the flag name has drifted across recent Codex releases). The
  // file is regenerated on every container start so it stays in
  // sync with the agent's configured system prompt.
  const home = process.env.HOME || os.homedir();
  const dir = path.join(home, ".codex");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  const filePath = path.join(dir, "AGENTS.md");
  writeFileSync(filePath, text, "utf8");
  console.log(`[agent-codex] wrote ${filePath}`);
  return filePath;
}

// ── System prompt ───────────────────────────────────────

const identityLine = workspaceName
  ? `You are ${platformName}, an AI assistant for ${workspaceName}.`
  : `You are ${platformName}, an AI assistant.`;

const workspacePromptSection = workspaceSystemPrompt
  ? `\n## Workspace Instructions\n\n${workspaceSystemPrompt}\n\n---\n`
  : "";

const agentKind = process.env.AGENT_KIND ?? "worker";

const systemPromptText = `${workspacePromptSection}${identityLine}

You are running as a ${agentKind} agent inside an x1agent session pod.
The user is watching this session in real time.

## Communication tools (via the x1agent MCP server)

- emit_status — announce the current phase of work.
- emit_artifact — show inline content (markdown, code, mermaid).
- emit_error — report a problem.
- end_session — declare the session complete.

Call emit_status at the start of each distinct phase. Be responsive — the
user is watching live.
`;

// ── Start session ───────────────────────────────────────

writeCodexInstructions(systemPromptText);

await postToSidecar("session.started", {
  agent_id: agentId,
  session_id: sessionId,
});
console.log(
  `[agent-codex] starting ${sessionMode} session ${sessionId} (model=${codexModel || "account-default"}, sandbox=${codexSandbox})`,
);

// ── Codex subprocess driver ─────────────────────────────

let activeCodex: CodexAppServer | null = null;
let codexThreadId: string | null = null;

function emitNormalized(event: NormalizedEvent | NormalizedEvent[] | null) {
  if (!event) return;
  const list = Array.isArray(event) ? event : [event];
  for (const e of list) emitToStream(e);
}

async function runCodexTurn(turnPrompt: string): Promise<void> {
  if (activeCodex) {
    if (!(activeCodex instanceof CodexAppServer) || !codexThreadId) {
      console.warn("[agent-codex] turn already in flight — ignoring overlap");
      return;
    }
    await activeCodex.turn(codexThreadId, turnPrompt);
    return;
  }
  idleTimer.setBusy(true);
  const server = new CodexAppServer({
    binary: codexBin,
    cwd: workspaceDir,
    model: codexModel,
    sandbox: codexSandbox === "danger-full-access" ? "danger-full-access" : "workspace-write",
    onEvent: ({ method, params }) => emitNormalized(normalizeCodexNotification(method, params)),
    onServerRequest: (request) => {
      if (request.id !== undefined) server.respond(request.id, { decision: "decline" });
    },
    onStderr: (line) => console.error(`[codex] ${line}`),
  });
  activeCodex = server;
  try {
    codexThreadId = await server.start();
    console.log(`[agent-codex] selected model=${server.model}`);
    await server.turn(codexThreadId, turnPrompt);
  } catch (error) {
    emitToStream({ type: "agent.error", payload: { message: (error as Error).message, recoverable: false } });
    server.stop();
    activeCodex = null;
  } finally {
    idleTimer.setBusy(false);
  }
}

/**
 * Spawn `codex exec --json` for a single prompt. Pipes JSONL stdout
 * through the normaliser. Resolves when the subprocess exits.
 */
/* Retained as a source reference while the app-server driver is exercised.
async function runCodexTurnLegacy(turnPrompt: string): Promise<void> {
  const args = [
    "exec",
    "--json",
    "-m",
    codexModel,
    "--sandbox",
    codexSandbox,
    "--cd",
    workspaceDir,
    turnPrompt,
  ];
  console.log(`[agent-codex] spawning: ${codexBin} ${args.slice(0, -1).join(" ")} <prompt:${turnPrompt.length}b>`);
  const proc = spawn(codexBin, args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Codex CLI honors CODEX_API_KEY; entrypoint.sh aliases
      // OPENAI_API_KEY into it for us, but defensively repeat here in
      // case run.ts is invoked outside the entrypoint (local dev).
      CODEX_API_KEY:
        process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || "",
    },
  });
  activeCodex = proc;

  // Per-line JSONL parser. Codex flushes one JSON object per stdout
  // line; tolerate empty lines and partial buffering.
  let buffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        emitNormalized(normalizeCodexEvent(parsed));
      } catch (err) {
        console.warn(
          `[agent-codex] failed to parse Codex JSONL line: ${(err as Error).message} — line: ${line.slice(0, 200)}`,
        );
      }
    }
  });
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    // Forward Codex CLI stderr to the pod log so auth / sandbox /
    // network failures surface alongside the harness's own output.
    for (const line of chunk.split("\n")) {
      if (line.trim()) console.error(`[codex] ${line}`);
    }
  });

  await new Promise<void>((resolve) => {
    proc.on("exit", (code, signal) => {
      activeCodex = null;
      idleTimer.setBusy(false);
      // Flush any trailing JSON without a newline terminator.
      if (buffer.trim()) {
        try {
          emitNormalized(normalizeCodexEvent(JSON.parse(buffer)));
        } catch {
          // ignore — partial garbage on exit isn't actionable.
        }
        buffer = "";
      }
      console.log(
        `[agent-codex] codex exited code=${code} signal=${signal ?? "none"}`,
      );
      if (code !== 0 && code !== null) {
        emitToStream({
          type: "agent.error",
          payload: {
            message: `codex exec exited with code ${code}`,
            recoverable: false,
          },
        });
      }
      resolve();
    });
  });
}
*/

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
        event_id?: string;
        wake_source?: string;
        share_id?: string | null;
        thread_id?: string | null;
        kind?: string;
        source?: string;
        origin?: {
          kind?: string;
          server?: string;
          share_id?: string | null;
          thread_id?: string | null;
        } | null;
      };
      if (typeof parsed.text !== "string") {
        res.writeHead(400);
        res.end("text required");
        return;
      }
      // Emit X1A-103 agent_thinking so the UI's indicator semantics
      // stay consistent across runtimes even though the v0 stub
      // doesn't actually push the message into a running Codex turn.
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

      const isShareCommentChannel =
        parsed.origin?.kind === "channel" &&
        parsed.origin?.server === "share-comments";
      if (!isShareCommentChannel) {
        emitToStream({
          type: parsed.request_id ? "user.input_response" : "user.message",
          payload: parsed.request_id
            ? { text: parsed.text, request_id: parsed.request_id }
            : { text: parsed.text },
        });
      }

      // Send the message into the long-lived app-server thread. The
      // thread preserves Codex conversation state across browser turns.
      void runCodexTurn(parsed.text).catch((error) => {
        emitToStream({ type: "agent.error", payload: { message: (error as Error).message, recoverable: false } });
      });
      console.log(
        `[agent-codex] /inject sent user message: ${parsed.text.slice(0, 100)}`,
      );
      res.writeHead(202);
      res.end("accepted");
    } catch (err) {
      res.writeHead(500);
      res.end((err as Error).message);
    }
  } else if (url.pathname === "/keepalive" && req.method === "POST") {
    resetIdleTimer();
    res.writeHead(200);
    res.end("ok");
  } else if (url.pathname === "/shutdown" && req.method === "POST") {
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
  console.log("[agent-codex] inject endpoint listening on :8788");
});

// ── Idle timeout ────────────────────────────────────────

let shuttingDown = false;

const idleTimer = new IdleTimer(idleTimeoutMs, sessionMode === "interactive", {
  onTimeout: () => {
    console.log(
      `[agent-codex] idle timeout (${idleTimeoutMs / 1000}s) — closing session`,
    );
    void shutdown(true, "Session closed due to inactivity");
  },
});

function resetIdleTimer() {
  idleTimer.reset();
}

async function shutdown(
  isSuccess: boolean,
  result?: unknown,
  error?: string,
): Promise<never> {
  if (shuttingDown) {
    await new Promise(() => {});
  }
  shuttingDown = true;
  idleTimer.dispose();
  if (activeCodex) {
    try {
      activeCodex.stop();
    } catch {
      // process may have already exited.
    }
  }
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

// ── Main ────────────────────────────────────────────────

resetIdleTimer();

// v0 driver: if a seed prompt is set (scheduler-triggered or the smoke
// test populated AGENT_PROMPT), run one Codex turn against it. Then,
// for oneshot mode, shut down; for interactive mode, park on the idle
// timer waiting for /inject (which is a stub in v0, so the session
// will eventually idle out — that's the documented v0 behaviour).
if (prompt) {
  eventBuffer.push({ type: "user.message", payload: { text: prompt } });
  await runCodexTurn(prompt);
  if (sessionMode === "oneshot") {
    await shutdown(true, "oneshot complete");
  }
} else {
  console.log(
    "[agent-codex] no AGENT_PROMPT seed; v0 parks on idle timer (interactive /inject is a stub)",
  );
}
