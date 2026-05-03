---
title: Codex CLI
description: x1agent integration spec for OpenAI's Codex CLI. The narrower-but-name-brand counterpart to opencode. Image layout, model wiring, adapter responsibilities, open questions.
sidebar:
  order: 2
---

[Codex CLI](https://github.com/openai/codex) is OpenAI's official open-source coding-agent CLI. It is narrower in scope than [opencode](/architecture/runtimes/opencode) — it talks only to OpenAI's models — but it is the canonical OpenAI agent and the right second runtime for x1agent to ship.

This page is the integration spec for `x1agent/runtime-codex:v1`. As with opencode, anything that depends on a specific upstream internal is flagged in [Open questions](#open-questions) rather than assumed.

## Why Codex CLI

- It is the **name-brand OpenAI runtime**. Operators evaluating x1agent expect symmetric Anthropic / OpenAI options, and Codex CLI is the credible OpenAI choice.
- It is **Apache 2.0**.
- It has **first-party knowledge of OpenAI tool-use semantics** that any third-party CLI re-implements at a lag.
- It is **complementary to opencode**, not redundant. opencode covers the multi-provider portability case; Codex CLI is the right pick when an operator has standardized on OpenAI and wants the official agent.

What it gives x1agent: an OpenAI-canonical option without writing it ourselves. It is a thinner integration than opencode because the model-config story is simpler (one provider).

## Image layout

```
x1agent/runtime-codex:v1
├─ FROM node:22-slim                    # or rust base — see Open questions
├─ apt: git, curl, ca-certificates, gh
├─ install codex-cli                    # exact install method TBD per upstream
├─ /x1/                                  # platform overlay
│  ├─ bin/entrypoint
│  ├─ bin/gh
│  ├─ bin/git-credential-x1
│  ├─ app/
│  │   ├─ run.sh                          # launches codex headless + adapter
│  │   ├─ adapter/                        # SSE/inject bridge
│  │   └─ config/                         # platform-owned codex config
│  ├─ runtime/bin/node
│  └─ etc/gitconfig
└─ USER agent                            # uid 1000, /home/agent
```

Same overlay, same shared scaffolding as every other runtime. `/x1/app/` is the only delta.

The base image choice depends on Codex's distribution. Earlier Codex releases were Node-based; recent versions moved to Rust. If the current release is Rust-built, we either:

- COPY a prebuilt binary into a `node:22-slim`-based image (keeps the platform's bundled Node + tsx working without surprises), or
- FROM `rust:1-slim-bookworm` and add the platform's bundled Node manually.

The first is simpler if the binary is statically linked. Verify in [Open questions](#open-questions).

## Model wiring

OpenAI is the only provider Codex talks to. Wiring is correspondingly simple:

- Codex's `OPENAI_BASE_URL` env points at the sidecar's AI-proxy port (`http://localhost:11432`).
- The sidecar holds the workspace's `OPENAI_API_KEY` in its secret store and adds it to outbound calls.
- Codex's `OPENAI_MODEL` env (or whatever the upstream env-var name is) is set per session by the orchestrator.
- No `OPENAI_API_KEY` is set in the agent container.

Permission gating: a session must have the `ai.openai` scope (and optionally `ai.openai:<model>`) for the sidecar to forward.

If Codex requires a real OpenAI org+project ID at startup (it sometimes does, depending on auth mode), that lookup belongs in the sidecar too — never in the agent container's env.

## The adapter

Same shape as opencode's adapter, narrower in mapping work:

- Spawns Codex in non-interactive mode.
- Translates Codex's session events to the platform's SSE schema on `:3100`.
- Listens on `:8788` for user-injection POSTs and forwards them into Codex's session.
- Surfaces upstream errors (rate-limit, model unavailable, billing) as platform-shaped events.

OpenAI's tool-use protocol is well-documented, so the event mapping is largely mechanical. The real surprises will be in how Codex CLI presents those events on its own boundary.

## What the operator sees

```yaml
workspaces:
  acme:
    agentRuntime:
      image: x1agent/runtime-codex:v1
    aiProviders:
      openai:
        secretRef:
          name: openai-key
          key: api-key
        org: org-xxxxx        # optional, depending on Codex auth mode
    permissionGrants:
      - scope: ai.openai
        models: ["gpt-5", "gpt-5-mini"]
```

Cleaner than the opencode example because there's only one provider section. The operator gets a Codex-shaped session with the same workspace, sidecar, and permissions wrapper.

## Build and ship

Standard runtime preset path through the in-cluster registry. Tags follow `x1agent/runtime-codex:vN`.

Validator updates:

- Accept `org.x1agent.runtime=codex` as a valid runtime label.
- Reject images that bake `OPENAI_API_KEY` into Dockerfile layers.

## Open questions

1. **Current distribution.** npm? a Rust binary? both? Verify the supported install path against the latest Codex release before sketching the Dockerfile.
2. **Base image choice.** If Codex is Rust-built and statically linked, the simpler path is to COPY the binary into a `node:22-slim` image (keeping the platform's bundled Node intact).
3. **Headless / event mode.** Does Codex have a JSON-streaming mode for its session events, or does the adapter need to parse human-formatted output?
4. **Auth mode.** Codex supports both API key and OAuth-with-OpenAI-account login flows. The platform integration uses the API key path through the sidecar; the OAuth flow is unsuitable here because it would require a browser inside the agent container.
5. **Tool-use schema.** Codex's tool-use event payloads — same as the OpenAI Chat Completions API, or something Codex-specific? Affects the adapter's mapping table.
6. **MCP support.** Does Codex consume MCP servers natively? If yes, the platform's [MCP servers](/providers/mcp-servers) flow plugs in directly; if not, the adapter has to register tools via Codex's own mechanism.
7. **Sandboxing assumptions.** Codex has its own sandboxing layer for shell tool calls. We are inside an x1agent pod that is already sandboxed, with the sidecar as the only egress. Codex's internal sandbox may need to be turned off (or aligned) so it doesn't fight the pod's security context.

## Out of scope for v1

- Codex Cloud (OpenAI's hosted Codex). We are integrating the open-source CLI, not the SaaS surface.
- Concurrent OpenAI org switching mid-session. One org per session.
- Custom fine-tuned model selection that bypasses the OpenAI public model catalog. v1 ships against the public catalog only.

## How this compares to opencode

| Concern | opencode | Codex CLI |
|---|---|---|
| Providers | Many | OpenAI only |
| License | Apache 2.0 | Apache 2.0 |
| Base image | `node:22-slim` | TBD (`node:22-slim` if binary; `rust:1-slim` if source) |
| Adapter complexity | Higher (multi-provider) | Lower (one provider) |
| Strategic role | Provider-portability hedge | Name-brand OpenAI option |

Both are first-class. Neither replaces the other. Operators who want flexibility pick opencode; operators who have standardized on OpenAI pick Codex.
