---
title: Pi
description: Stub. Pi is named in the platform's runtime menu but the upstream pointer needs to be confirmed before this spec is filled in.
sidebar:
  order: 3
---

> **Status: stub.** This spec is intentionally not written yet. The platform's [Runtime images](/architecture/runtime-images) doc names "Pi" as a planned successor runtime, and the maintainer of the Pi project is referenced as Mario Zechner. Before this page can be filled in, we need:
>
> - The upstream repository URL for the Pi coding-agent CLI.
> - The license under which Pi is distributed.
> - The CLI's distribution channel (binary, npm, source).
> - Confirmation that Pi exposes a non-interactive event stream the adapter can consume.
>
> This file is a placeholder so the runtime catalog stays internally consistent and so a future PR has a known location to land the spec. Most likely upstream candidate: [`badlogic/pi`](https://github.com/badlogic/pi) — confirm with the CEO before treating this as canonical.

## What we know going in

The platform's existing docs already commit to supporting Pi:

- [Runtime images — Design principles](/architecture/runtime-images#design-principles) historically cited "Pi's `Bash`" as an example of why the agent's shell must be local, not RPC-proxied. (That citation is being narrowed in a parallel doc-cleanup pass; see [audit follow-ups](#).)
- [Agent runtimes](/architecture/agent-runtimes) lists Pi in the runtime menu as _stub_ status pending an upstream pointer.

So Pi is on the runtime trajectory but not yet a concrete commitment; the integration spec needs grounding in the actual upstream rather than placeholder text before this page can be more than a stub.

## What this spec will look like once filled in

Mirror of [opencode](/architecture/runtimes/opencode) and [Codex CLI](/architecture/runtimes/codex):

1. Why Pi (the strategic-fit one-liner).
2. Image layout (Dockerfile sketch with the platform's standard `/x1/` overlay).
3. Model wiring (how Pi names providers and base URLs; how the sidecar AI-proxy plugs in).
4. Adapter responsibilities (Pi's native events ↔ `:3100` SSE).
5. What the operator sees (Helm values example).
6. Build and ship.
7. Open questions (anything not verified against upstream).
8. Out of scope for v1.

The contract from [Agent runtimes — The runtime contract](/architecture/agent-runtimes#the-runtime-contract) applies as-is: Pi must run as `agent` at uid 1000, expose `:3100` and `:8788`, run a real local shell, and route credentials through the sidecar.

## Action

Hand over the upstream URL and any contributor / contact pointer, and this stub becomes a real spec on the next pass.
