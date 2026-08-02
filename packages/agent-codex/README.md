# @x1agent/agent-codex

Alternative agent runtime that drives [OpenAI Codex](https://platform.openai.com/docs/codex) instead of the Claude Agent SDK. Parallel to `packages/agent/` (the Claude runtime) and produces the `x1agent/runtime-codex` container image.

**Status: testable integration.** The runtime uses the Codex app-server JSON-RPC protocol, so interactive follow-up turns work through `/inject`. Approval requests are declined because the x1agent pod is the sandbox boundary; OpenAI cost telemetry and sub-agent spawning remain future work.

## What's in the image

- Node 22 base, `@openai/codex` CLI installed globally.
- The full `/x1` overlay (`/x1/bin/entrypoint`, `/x1/runtime/`, `/x1/app/`) duplicated from the runtime-claude image's pattern. Follow-up work extracts this into a single `runtime-core` source both images `COPY --from`.
- One bundled MCP server: `x1-mcp.ts`, mounted as `[mcp_servers.x1agent]` in `~/.codex/config.toml` rendered at pod boot.
- The standard pod shape (SSE on `:3100`, `/inject` on `:8788`, sidecar on `:9090`).

## How a turn runs

```
pod (container: x1agent/runtime-codex)
 └─ x1agent-runner (Node + tsx, packages/agent-codex/src/run.ts)
     ├─ subprocess: `codex app-server --stdio`
     │  └─ JSON-RPC JSONL → normalize.ts → {type, payload} events
     ├─ stdio MCP: x1-mcp.ts (POSTs to sidecar :9090)
     ├─ HTTP :3100 (SSE — sidecar consumes)
     └─ HTTP :8788 (inject — starts a follow-up turn)
```

The harness initializes one Codex thread, reads `AGENT_PROMPT` as its first turn, and sends subsequent `/inject` messages through `turn/start` on that same thread. App-server deltas and completed items are translated to the platform event shapes the api subscriber and browser already understand (`session.init`, `agent.text`, `agent.tool_call`, `agent.tool_result`, `agent.thinking`, `agent.error`).

`turn.completed` is logged to stdout (model + token counts) but **not** emitted as `agent.usage`. The api's cost-rollup pricing table has Anthropic models only; sending a Codex usage row would break the integration. Adding OpenAI pricing rows is v1 work.

## Configuration

Environment variables consumed by `src/run.ts`:

| Var | Default | Notes |
|---|---|---|
| `SESSION_ID` | (required) | Session UUID. |
| `OPENAI_API_KEY` | (required) | Aliased to `CODEX_API_KEY` inside the entrypoint. |
| `OPENAI_MODEL` | `gpt-5-codex` | Passed to `thread/start` and `turn/start`. Override for a deployment with a model supported by its auth mode. |
| `CODEX_SANDBOX` | `workspace-write` | Try first; flip to `danger-full-access` if Bubblewrap fails under the pod's securityContext. |
| `CODEX_PATH` | `codex` | Override for the CLI binary (only useful in local dev). |
| `WORKSPACE_DIR` | `/workspace` | `--cd` value. |
| `SIDECAR_URL` | `http://localhost:9090` | Where x1-mcp POSTs tool events. |
| `SIDECAR_HEALTH_URL` | `http://localhost:9091` | Polled on boot before any sidecar POST. |
| `AGENT_PROMPT` | `""` | Seed prompt. Empty → harness waits for the first `/inject` turn. |
| `IDLE_TIMEOUT_MS` | `900000` | Pod exits after this many ms with no activity. |

The image's `x1-entrypoint.sh` aliases `OPENAI_API_KEY` into `CODEX_API_KEY` so we don't need a separate env-var slot on every pod — the Codex CLI accepts either, and the platform already plumbs `OPENAI_API_KEY` through Terraform → GSM → ESO → api pod env.

## Reproducing the smoke test in dev (OrbStack)

The acceptance criterion for the spike is: **a pod from this image boots, answers a hello-world prompt, and emits at least one `agent.text` + one `agent.tool_call` event on NATS `x1.session.<id>.events`.**

1. **Build the image.** From the package root:

   ```bash
   cd packages/agent-codex
   docker build -t x1agent/runtime-codex:dev .
   ```

   In OrbStack the local Docker daemon already feeds the in-cluster registry, so no push is needed.

2. **Seed an `agent_images` row** pointing at the new image. Until X1A-? lands a proper UI, do this manually via the configurator or psql:

   ```sql
   INSERT INTO agent_images (id, slug, built_ref, status, ...)
   VALUES (gen_random_uuid(), 'runtime-codex-dev', 'x1agent/runtime-codex:dev', 'ready', ...);
   ```

3. **Create or update an agent** to point at that image row (`agents.image_id`). Pod-spec infers the Codex runtime from the image ref via `isCodexRuntimeImage()` — anything matching `/runtime-codex/i` or `/agent-codex/i` triggers the `OPENAI_API_KEY` branch.

4. **Trigger a session** for the agent. The api's job-watcher will build a pod-spec whose agent container has the Codex login mounted; the entrypoint aliases API credentials when present and runs the app-server against `gpt-5-codex` by default.

5. **Watch NATS** to confirm the event sequence:

   ```bash
   kubectl -n x1agent exec -ti deploy/nats -- nats sub 'x1.session.>'
   ```

   You should see — at minimum — one `session.init`, one `agent.tool_call` for `mcp__x1agent__emit_status` (the system prompt instructs the agent to call it at the start of each phase), and one `agent.text` for the model's reply.

If you don't see any Codex events, check the agent container's log first:

```bash
kubectl -n x1agent logs job/<session-job-name> -c agent
```

Common failure modes:

- `codex: command not found` — image didn't install `@openai/codex`. Rebuild.
- `codex app-server` fails during initialization — usually missing/invalid `CODEX_API_KEY`. Check the agent container log.
- `Bubblewrap failed` / `sandbox setup error` — pod's securityContext is rejecting the workspace-write sandbox. Set `CODEX_SANDBOX=danger-full-access` on the agent's env (or via a one-off pod-spec patch) and re-run; the pod is already the security boundary.

## What this spike deliberately doesn't do

- **No explicit turn steering/interrupt yet.** Follow-up turns work, but the harness does not yet expose separate `turn/steer` or `turn/interrupt` controls.
- **No additional MCPs.** Only `x1-mcp.ts` is mounted. Files / Sheets / Docs / Calendar / Email / Zone-3 remote_oauth MCPs are out for v0.
- **No `agent.usage` event.** Logged to stdout only; the api's cost-rollup needs OpenAI pricing rows before this can be wired safely.
- **No `agents.runtime` column.** The runtime is inferred from `agents.image_id`. A schema migration adding an explicit enum is v1 work.
- **No sub-agent spawning, approval flow, hot-restart, or compaction.**

## Follow-up work

- Extract `idle-timer.ts`, `input-channel.ts`, `image-tokens.ts`, `event-correlator.ts`, `wake-classifier.ts`, `x1-mcp.ts` into a shared `packages/agent-runtime-base/` (or `packages/agent-mcp-x1/` for the MCP) so both runtimes pull from one source. Marked with `TODO(codex-spike)` comments at the top of each duplicated file.
- Land the `agents.runtime` schema migration and surface a runtime picker in the agent edit UI.
- Add explicit `turn/steer` / `turn/interrupt` handling and surface approval events in the UI if x1agent later wants user-mediated approvals.
- Add OpenAI pricing rows to the cost-rollup tables and emit `agent.usage` for Codex turns.
- Decide whether Codex Enterprise access tokens (GA May 2026) belong as a third auth source alongside API key and Vertex.
