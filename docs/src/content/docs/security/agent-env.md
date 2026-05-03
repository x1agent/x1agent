---
title: Agent env injection
description: When and how operators expose workspace secrets directly to the agent container's environment, the threat model that follows, and how the UI signals which agents are trusted.
sidebar:
  order: 3
---

The workspace secret store has **two attachment zones** for agents. Both source from the same `${NAME}` references; they differ in which container the plaintext value lands in.

| Zone | Plaintext lands in | Agent can read | Use when |
|---|---|---|---|
| **MCP-mediated** | The MCP server's container only | No — agent only sees the MCP's tool output | Third-party API keys consumed via an MCP tool (Linear, Slack, Mercury, Drive) |
| **Agent env** | The agent container's `process.env` | Yes — bash, scripts, the LLM's tool calls all see it | Credentials the agent itself needs to operate (its own model API key, its own GitHub PAT, deploy tokens) |

Zone 1 (MCP-mediated) is documented in [MCP servers](/providers/mcp-servers). This page is about Zone 2.

## Why Zone 2 exists

Some agents need to *be* an authenticated principal — a worker that pushes commits, a build agent that calls Anthropic with the operator's own API key, a deploy agent that runs `kubectl apply` against its own service account. For those, hiding the credential behind an MCP server is the wrong shape: the agent's bash tool needs to see the env var so `git push`, `npm install`, `gcloud auth activate-service-account`, etc. just work.

Zone 2 acknowledges this need explicitly and surfaces it as a per-agent configuration choice, not an accidental leak.

## How it's configured

On the agent edit screen, an **Environment variables** section lets the agent author map workspace secrets to env-var names the agent will see at runtime:

```
Agent env:
  ANTHROPIC_API_KEY  ←  ${MY_ANTHROPIC_KEY}        [edit] [unlink]
  GITHUB_TOKEN       ←  ${WORKER_GH_PAT}           [edit] [unlink]
  + Add env var
```

The left column is the env-var name as the agent sees it. The right column is the workspace secret it resolves to. Mapping is explicit because the workspace secret name is generally not the env-var name the agent's tooling expects.

At session-start time the api's pod-spec generator translates each row to a `valueFrom.secretKeyRef` against the workspace's secret bundle. Plaintext never transits the pod spec. The agent container starts with these vars in its env; everything the agent runs (bash, the LLM's tool calls, child processes) inherits them.

## The threat model

Anything the agent can run can read every Zone 2 var. Concretely:

- The LLM can be prompt-injected. A successful injection that gains shell access reads every Zone 2 secret with one `env` call.
- Tool output is logged. `gh push` writes credential headers to stderr that flow to session events, Sentry, and audit logs. Sanitize at source if this matters; rotate if a leak is suspected.
- Sub-agents inherit the env. An agent that spawns child processes hands every Zone 2 var to every child unless the parent strips them.

In short: Zone 2 is a **trust grant from the operator to the agent**. The operator is saying "I want this agent to act with these credentials." Treat it like adding a key to a CI runner — necessary for some workflows, but every consumer of that runner's output is a potential exfil channel.

## Visual signals

Agents that have any Zone 2 secrets attached display an **operator-injected credentials** badge on:
- The agent detail page header
- The sessions list (per-session row when the session was launched from a Zone-2 agent)
- The agent edit screen (next to the Environment variables section)

The badge is intentional friction. An agent that quietly has `ANTHROPIC_API_KEY` in its env should not look identical at a glance to one that doesn't. Workspace admins reviewing the agent catalog can spot Zone 2 trust grants without opening every edit screen.

## What does *not* go in Zone 2

| Don't put in Zone 2 | Reason |
|---|---|
| Per-user OAuth tokens (Google Drive, Calendar, Slack as the user) | These are user-scoped and consent-gated; they belong in the [credential proxy](/security/credential-proxy) |
| API keys for tools an MCP exists for | Use the MCP path — same secret value, but the agent never sees it |
| Org-wide signing keys, JWT secrets, master encryption keys | These are platform-internal, not workspace-managed |
| Anything that grants more privilege than the agent's task requires | Lift-and-shift the credential set from a CI runner config; cut it down to what's actually needed |

## Preview environments

Preview env configurations have the same Zone-2 mechanism. The same workspace secrets store, the same `${NAME}` reference syntax, the same `valueFrom.secretKeyRef` materialization. A preview env that needs `DEPLOY_TOKEN` declares it the same way an agent does. The threat model is identical — anything the preview can run can read those vars.

## Rotation

Rotating a workspace secret used in Zone 2 takes effect on the **next session** that boots the agent. Already-running sessions hold the prior value in their env until they exit. There is no live in-process re-injection. For long-running orchestrator agents, restart the agent's session to pick up rotated values.

## Related

- [MCP servers](/providers/mcp-servers) — Zone 1, the don't-let-the-agent-see-it path
- [Secrets management](/security/secrets) — the underlying storage model (External Secrets Operator, K8s Secret materialization)
- [Security overview](/security/overview) — trust levels and the five principles
