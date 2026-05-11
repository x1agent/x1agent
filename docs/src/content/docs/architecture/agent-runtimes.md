---
title: Agent runtimes
description: The pluggable layer that sits between x1agent and the LLM coding-agent CLI. Why it's plural, what the contract is, and which runtimes the platform ships.
sidebar:
  order: 7
---

:::caution[Status: trajectory, not shipping reality]
Today the platform ships **one** runtime: the Claude Agent SDK, baked into
the image labelled `runtime-core` (see [Runtime images](/architecture/runtime-images)).
This page describes the contract every future runtime will satisfy and the
work needed to land the second one. Sections marked _Planned_ are not yet
implemented in code; the trajectory is tracked in
[`ROADMAP.md`](https://github.com/x1agent/x1agent/blob/main/ROADMAP.md).
:::

x1agent runs LLM coding agents inside isolated pods. The agent CLI itself — Claude Code, opencode, Codex, Pi — is the **agent runtime**. The platform is deliberately runtime-plural: an admin picks which CLI runs in their session, and the same workspace, sidecar, and permission model wraps any of them.

This doc specifies why that plurality exists, what each runtime must implement to integrate, and how the platform-maintained runtime images relate.

The companion docs are [Runtime images](/architecture/runtime-images) (the pod shape and the `/x1/` overlay), [Credential proxy](/security/credential-proxy) (how secrets reach the runtime), and the per-runtime specs under `runtimes/` in this section.

## Why runtime-plural

A single coding-agent CLI is a single point of failure: provider outages, regional capacity, model-availability gaps, vendor pricing pivots, license changes. An operator running production agents needs the choice to swap runtimes without rewriting their workflow.

Concretely:

- **Provider failure isolation.** If Vertex Anthropic 429s every call (a real failure mode — see the post-mortem on the original sonnet-4-5 quota wall), an operator running opencode flips to Bedrock or OpenAI in one config change and keeps shipping.
- **Workload-fit.** Claude Code is excellent at long-form planning and refactoring. Codex CLI is faster for tight, high-volume edits against OpenAI models. opencode is the only one that natively cycles between Anthropic, OpenAI, Bedrock, and local Ollama from a single CLI. Letting the operator pick per-agent matches the workload.
- **License and cost optionality.** opencode and Codex are Apache 2.0 and source-available respectively. Self-hosting an open-weights model under opencode is a viable cost path; a single-vendor stack isn't.
- **Roadmap insulation.** When Anthropic ships a new SDK feature or OpenAI changes their tool-use protocol, only the affected runtime image moves. The platform contract — sidecar, permissions, sessions, providers — doesn't.

The trade is real complexity in keeping N runtimes plumbed. The platform absorbs that complexity once so workspace admins don't have to.

## The runtime contract

A runtime is "a runtime" if it satisfies five things. Anything that does is shippable as an `x1agent/runtime-<name>` image.

### 1. The pod shape doesn't change

Every runtime image — Claude Code, opencode, Codex, Pi, or anything authored later — produces a container that fits the [pod shape](/architecture/runtime-images#the-pod-shape) without modification. Same `agent` user at uid 1000, same `/workspace` mount, same `/x1/` overlay tree, same sibling-container compatibility. Operators don't get a different pod for a different runtime.

### 2. The agent CLI runs as `agent`

No exceptions. uid 1000, gid 1000, home at `/home/agent`. The runtime's CLI authenticates files, git, and shell as that identity. See [Runtime images — Preset contract](/architecture/runtime-images#preset-contract).

### 3. Native shell, not RPC

The CLI's bash tool runs `/bin/bash` directly inside the agent container — real PIDs, real TTYs, real file descriptors. No proxy, no daemon, no MCP wrapper around shell. This is enforced upstream in the platform's principles and applies to every runtime. A CLI that can only invoke shell through an RPC tunnel is not a candidate.

### 4. Two endpoints: events out, inject in

The CLI exposes its turn stream as **SSE on `:3100`** and accepts user-injection messages as **HTTP POST on `:8788`**. These are the two ports the API server attaches to per session. A runtime that has its own native event format (every one does — Anthropic's, OpenAI's, opencode's are all different) ships an adapter inside `/x1/app/` that translates to the platform's event schema. See the per-runtime specs.

### 5. Credentials come from the sidecar, never the env

The agent container has **no** API keys, OAuth tokens, or service-account JSON in its environment. Three categories, three flows:

- **AI inference credentials** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, Vertex SA, etc.). The agent CLI is configured to point its base URL at the sidecar's AI-proxy port. The sidecar holds the real credential and forwards. This is a forthcoming extension to the [credential-proxy](/security/credential-proxy) — today's proxy handles OAuth user tokens; runtime support requires it to also terminate AI inference HTTPS. See [Open extensions](#open-extensions) below.
- **Per-user OAuth tokens** (Graph, Calendar, Slack, Google Drive). Already proxied via NATS through the sidecar. Unchanged.
- **Repo access** (gh, git push). Already proxied via the GitHub-credential shim documented in [Repository access](/security/repo-access). Unchanged.

A runtime that hard-codes a base URL or refuses to honor `*_BASE_URL` env vars is not a candidate.

## How a runtime image is built

The pattern follows [Runtime images — runtime-core and the overlay pattern](/architecture/runtime-images#runtime-core-and-the-overlay-pattern), with the `/x1/app/` directory specialized per runtime.

```
x1agent/runtime-claude-code:v1   /x1/app = @anthropic-ai/claude-code + adapter
x1agent/runtime-opencode:v1      /x1/app = opencode CLI + adapter
x1agent/runtime-codex:v1         /x1/app = @openai/codex + adapter
x1agent/runtime-pi:v1            (TBD — see runtimes/pi.md)
```

Everything outside `/x1/app/` is shared:

- `/x1/runtime/bin/node` and bundled tsx.
- `/x1/bin/entrypoint`, `/x1/bin/gh`, `/x1/bin/git-credential-x1`.
- `/x1/etc/gitconfig`.
- The `agent` user, the chown rules, the entrypoint shape.

This means today's `x1agent/runtime-core` is not the universal base — it's specifically `runtime-claude-code` under the current name. Renaming that image (and re-tagging downstream presets) is the first concrete step toward the runtime-plural state. See [Implementation arc](#implementation-arc).

## The runtime menu

The platform ships these images. New ones are added by writing the corresponding `runtimes/<name>.md` spec, building the image, and validating the contract.

| Runtime | Image | License | Models supported | Status |
|---|---|---|---|---|
| Claude Code | `x1agent/runtime-core:v1` _(rename to `runtime-claude-code` planned)_ | Anthropic, source-available | Anthropic only (api.anthropic.com or Vertex) | **shipping** |
| opencode | `x1agent/runtime-opencode:v1` | Apache 2.0 | Anthropic, OpenAI, Bedrock, Vertex, local Ollama, others | _spec only_ — see [runtimes/opencode](/architecture/runtimes/opencode); no image, no adapter |
| Codex CLI | `x1agent/runtime-codex:v1` | Apache 2.0 | OpenAI only | _spec only_ — see [runtimes/codex](/architecture/runtimes/codex); no image, no adapter |
| Pi | `x1agent/runtime-pi:v1` | TBD | TBD | _stub_ — see [runtimes/pi](/architecture/runtimes/pi); upstream pointer needed |

The choice of which to ship first is opinionated. The first non-Claude runtime should be **opencode**, because it is the only candidate that is itself runtime-plural at the model layer. Adopting opencode gives an x1agent operator access to every major commercial model and any local Ollama-compatible model from one runtime image. That's the strongest single answer to the "single point of provider failure" problem motivated above.

Codex CLI is the right second pick: it's the canonical OpenAI agent, source-available, and gives x1agent a name-brand symmetric option to Claude Code. Implementation effort is similar to opencode's; both are TypeScript / Rust CLIs with an event loop we adapt around.

## How an admin picks a runtime

Today the agent's image is selected on the agent config (one image, one runtime, baked into the Helm-deployed catalog). The runtime-plural model adds a thin layer:

1. The platform maintains the **runtime catalog** at `<in-cluster-registry>/x1agent/runtime-<name>:<version>`.
2. An admin's preset Dockerfile chooses its overlay source: `ARG AGENT_OVERLAY=x1agent/runtime-opencode:v1` instead of `runtime-core`.
3. The save-time validator accepts any image whose overlay points at a published runtime image and rejects anything else.
4. Per-session config can pin to a specific runtime tag if reproducibility matters.

No agent code in `packages/agent/` knows which runtime is in the image — the image's `/x1/app/` is self-describing through the SSE / inject contract.

## Open extensions

Two pieces of the platform need to grow before the second runtime is fully integrated. Both are tractable but neither is "no-op."

### AI-inference proxy in the sidecar

_Planned, not implemented._ Today the sidecar (`packages/sidecar/`) terminates OAuth-token-bearing requests over NATS and exposes only `:9090` to the agent container. To keep AI provider keys out of the agent container, the sidecar will also need to terminate AI inference HTTPS:

- A local TCP listener inside the pod (port TBD; `:11432` is a placeholder until the sidecar lands a route).
- The agent CLI is configured with `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `BEDROCK_BASE_URL` pointing at that listener.
- The sidecar adds the actual provider key from the workspace's secret store and forwards to the real upstream.
- Audit log entry per call (provider, model, token counts, scope).

This is a **proper extension** of the credential-proxy pattern, not a new mechanism. Permissions check: a workspace permission grant determines which providers and models a session may call.

### Permission ledger entries for AI providers

_Planned, not implemented._ Today the registered grant types are `spawn` and `tool_scope` (see `packages/domains/permissions/src/domain/details/registry.ts`). The ledger needs new entries for AI inference: `ai.anthropic`, `ai.openai`, `ai.bedrock`, `ai.vertex`, with optional model filters (`ai.anthropic:claude-sonnet-4-5`, `ai.openai:gpt-*`). Operators would then control which sessions can call which models. This makes "we accidentally burned $5k on opus while testing a haiku-grade task" preventable rather than postmortem material.

### Existing code that's Claude-coupled

The save-time validators, the agent SDK at `packages/agent/`, and the entrypoint script were written when "the runtime" meant Claude Code only. Three things need clean abstraction work, not new code:

- `packages/agent/Dockerfile` becomes the Claude-Code-specific runtime image. The shared overlay scaffolding (gitconfig, gh shim, entrypoint contract) lifts into a smaller `x1agent/runtime-base` image that all runtimes COPY from.
- The entrypoint script's `exec node /x1/app/src/run.ts` is Claude-Code-specific. Each runtime's `/x1/app/` provides its own entrypoint binary; the shared script becomes a 5-line dispatcher.
- The image-save validator (`packages/domains/image-catalog/src/domain/dockerfile-source.ts`) does not currently inspect image contents — it validates Dockerfile directives only. A new check is added: the resulting image must carry an `org.x1agent.runtime=<known>` label (e.g. `org.x1agent.runtime=opencode`).

None of these are big refactors. They're each contained changes, but the work is real and lives under [Implementation arc](#implementation-arc).

## Implementation arc

A roughly-ordered sequence to land the second runtime. Each step is independently mergeable. **All steps are currently in status _not started_.**

1. **Rename `runtime-core` to `runtime-claude-code`** _(not started)_ — and split out `runtime-base` as the shared overlay scaffolding. The current image keeps shipping under the old tag for one minor version to avoid breakage.
2. **Sidecar AI proxy** _(not started)_ — implement the local listener, the workspace-secret-backed provider lookup, and the audit log entry. Write the contract tests.
3. **Permission ledger AI entries** _(not started)_ — add the new scope class, plumb it through the consent UI, gate the proxy on it.
4. **Build `runtime-opencode:v1`** _(not started)_ — new Dockerfile, opencode CLI installed, adapter that translates opencode's session events to `:3100` SSE. Validate the contract end-to-end against a real session.
5. **Validator updates** _(not started)_ — accept any image with `org.x1agent.runtime=<name>` where `<name>` is in the supported list; reject hard-coded Claude assumptions.
6. **Build `runtime-codex:v1`** _(not started)_ — same pattern as opencode, narrower in model scope.
7. **`runtime-pi:v1`** _(not started)_ — pending an upstream pointer (see [runtimes/pi](/architecture/runtimes/pi)).
8. **Docs and the admin UI** _(not started)_ — make the runtime choice visible in the admin agent-config screen. Default to Claude Code; opencode is one click away.

## What this doc does not cover

- The exact SSE event schema on `:3100`. That belongs in [Architecture overview — runtime interface](/architecture/overview#runtime-interface) and is shared by every runtime.
- The Dockerfile contents for each runtime. Those are in the per-runtime specs.
- How an admin onboards a brand-new runtime not in the platform catalog. v1 is closed-catalog; bring-your-own-runtime is later work.
- Provider-specific quirks (Vertex regional gating, Bedrock account requirements, OpenAI org limits). Those are upstream-cloud concerns the operator manages outside x1agent.
