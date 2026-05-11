---
title: opencode
description: x1agent integration spec for the opencode coding-agent CLI. Image layout, model wiring, the adapter that bridges opencode's event stream to the platform's :3100 SSE contract, and the open implementation questions.
sidebar:
  order: 1
---

[opencode](https://opencode.ai) is a TUI-first, Apache 2.0 coding-agent CLI maintained by the SST team. It connects to multiple model providers (Anthropic, OpenAI, Bedrock, Vertex, local Ollama, others) from a single binary and is the strongest single answer to x1agent's "single point of provider failure" problem — see [Agent runtimes — Why runtime-plural](/architecture/agent-runtimes#why-runtime-plural).

This page is the integration spec for `x1agent/runtime-opencode:v1`. It does not assume any opencode internal that has not been verified against the upstream source — see [Open questions](#open-questions) for the items that need confirmation before implementation.

## Why opencode is the slam-dunk first non-Claude runtime

| Property | Why it matters here |
|---|---|
| Apache 2.0 license | No license-cost surprises. Self-host friendly. |
| Multi-provider out of the box | One image, every model. Vertex Anthropic 429s? Same image flips to OpenAI in env. |
| Active community on GitHub | Issue throughput and release cadence are real. Not a hobby fork. |
| TypeScript/Node baseline | Aligns with x1agent's existing `node:22-slim` base; minimal toolchain churn. |
| TUI-first design | Operator-friendly for the dark-factory coding vertical. The TUI is also scriptable, which the adapter relies on. |

The thing it gives x1agent that no other runtime does: **provider portability inside one runtime**. With Claude Code or Codex, swapping providers means swapping runtimes. With opencode, swapping providers is an env-var change.

## Image layout

```
x1agent/runtime-opencode:v1
├─ FROM node:22-slim                    # glibc bookworm — same constraint as the other runtimes
├─ apt: git, curl, ca-certificates, gh  # platform standard
├─ npm i -g opencode                    # CLI binary on PATH
├─ /x1/                                  # the platform overlay
│  ├─ bin/entrypoint                     # delegates to /x1/app/run.sh
│  ├─ bin/gh                             # gh CLI
│  ├─ bin/git-credential-x1              # sidecar credential shim
│  ├─ app/                                # opencode + adapter
│  │   ├─ run.sh                          # launches opencode in headless mode + adapter
│  │   ├─ adapter/                        # the SSE/inject bridge — see below
│  │   └─ config/                         # opencode config the platform owns
│  ├─ runtime/bin/node                    # bundled Node 22
│  └─ etc/gitconfig                       # standard
└─ USER agent                            # uid 1000, /home/agent
```

The image follows [Runtime images — Preset contract](/architecture/runtime-images#preset-contract) verbatim. The only thing different from `runtime-claude-code` is the contents of `/x1/app/`.

> **Implementation note**: the exact opencode install method and config-file shape is the first item in [Open questions](#open-questions). The Dockerfile sketch above assumes the npm package distribution path; if upstream ships the binary differently the install layer changes.

## Model wiring

The platform passes inference through the sidecar, not directly to the provider — this is non-negotiable per [Agent runtimes — The runtime contract](/architecture/agent-runtimes#the-runtime-contract). For opencode, that translates to:

- The sidecar will expose a local AI-proxy listener (port TBD; see [Agent runtimes — Open extensions](/architecture/agent-runtimes#open-extensions) for the unlanded sidecar work this depends on).
- opencode's provider config lives in `/x1/app/config/opencode.json` (or whatever the upstream config name turns out to be) and points each enabled provider's base URL at `http://localhost:11432`.
- opencode is started with `OPENCODE_PROVIDER=<name>` and `OPENCODE_MODEL=<id>` set per session (or whatever the upstream env-var names are — see [Open questions](#open-questions)).
- The sidecar receives the request, looks up the workspace secret for the named provider, adds the auth header, forwards to the real upstream, returns the response.
- No `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. is set in the agent container.

Permission gating happens at the sidecar: if the session is not granted the `ai.<provider>` (and optionally `ai.<provider>:<model>`) scope, the call returns 403 before any upstream traffic.

## The adapter

opencode has its own session-event format. The platform wants every runtime's events on a uniform SSE schema served at `:3100` (per [Runtime images — Relationship to other runtimes](/architecture/runtime-images#relationship-to-other-runtimes)) so the orchestrator, UI, and audit pipeline don't care which runtime is underneath.

The adapter's job:

```
opencode native event stream  ──▶  /x1/app/adapter  ──▶  SSE on :3100
HTTP POST :8788 (user inject) ──▶  /x1/app/adapter  ──▶  opencode stdin / inject API
```

Concretely, the adapter:

1. Spawns opencode in a non-interactive mode that emits events as JSON on stdout (or whatever upstream provides — TBD per [Open questions](#open-questions)).
2. Translates each event to the platform's [SSE schema](/architecture/overview#runtime-interface): `turn.start`, `tool.use`, `tool.result`, `assistant.message`, `turn.end`.
3. Listens on `:8788` for user-injection POSTs, forwards them into opencode's session.
4. Surfaces opencode's internal errors (rate-limit, provider down, model unavailable) as platform-shaped error events so the UI shows the same affordance regardless of runtime.

The adapter is small (target: under 500 lines) and lives in `/x1/app/adapter/` inside the image. It does not modify opencode itself.

## What the operator sees

An admin in the `acme` workspace:

1. Stores their `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` as
   [workspace secrets](/providers/mcp-servers#workspace-secrets).
2. Switches the workspace's agent runtime image to `x1agent/runtime-opencode:v1`
   on the agent-config page (workspace-scoped setting, not a Helm value —
   the install-wide chart never names a specific workspace).
3. Grants the session the `ai.anthropic` and `ai.openai` scopes (with
   optional model filters) through the existing
   [permission grants](/security/permission-grants) flow, once the new
   scope class lands per
   [Agent runtimes — Open extensions](/architecture/agent-runtimes#open-extensions).

When the agent runs, the user's choice of provider in the opencode TUI is gated by which providers are configured at the workspace level and which the session has been granted.

## Build and ship

The image is a regular preset built through the in-cluster registry (see [Deployment — In-cluster registry](/deployment/in-cluster-registry)). Tagging follows the standard pattern: `x1agent/runtime-opencode:vN` for stable, `x1agent/runtime-opencode:edge` tracking main.

Validator updates required:

- Accept `org.x1agent.runtime=opencode` as a valid runtime label.
- Require `/x1/bin/entrypoint` to exist and exit 0 with `--healthcheck` (same as every runtime).
- Reject images that bake `OPENCODE_API_KEY` (or whichever env opencode uses for direct provider auth) into the Dockerfile or its layers.

## Open questions

Items I did not assume. Each is small but blocks a clean implementation; each has a clear path to resolution.

1. **Distribution path.** Is opencode shipped via npm, a single binary, or both? The Dockerfile install layer depends on this.
2. **Headless / scripted mode.** Does opencode have a non-TUI mode that emits structured events on stdout, or does the adapter need to drive the TUI? Likely the former — verify against upstream.
3. **Provider config schema.** What's the exact config file path and JSON shape for setting per-provider base URLs and model lists? Verify against upstream.
4. **Native event format.** What event types does opencode emit, and at what granularity? Build the SSE-mapping table from the upstream definition, not from inference.
5. **MCP and tool extensions.** How does opencode discover MCP servers? x1agent's [MCP servers](/providers/mcp-servers) flow needs to compose with whatever opencode's discovery is.
6. **Inject endpoint shape.** Does opencode accept user injection via stdin, an HTTP API, or a signal? Adapter implementation depends on this.
7. **License confirmation.** opencode is Apache 2.0 as of writing; re-confirm at image-build time so we never ship a runtime under an unexpected license.

These are the questions to answer in the first commit that touches the image. Until they are, this doc is design intent, not spec. Per the platform's anti-confabulation rule: better to ship a doc that names what we don't know than one that invents a plausible-sounding upstream.

## Out of scope for v1

- Bring-your-own-opencode-fork. The platform pins to upstream main releases. A workspace that wants a custom fork is out of scope for v1.
- Local-model serving inside the agent pod. Ollama lives elsewhere — either a sibling container, a workspace-local runtime service, or an external endpoint the sidecar proxies to. The runtime image does not bundle model weights.
- Multi-agent simultaneity inside a single runtime image. One opencode process per session pod. Multi-agent orchestration is the orchestrator's concern, not the runtime image's.
