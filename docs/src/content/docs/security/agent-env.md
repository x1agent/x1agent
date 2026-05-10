---
title: Agent env injection
description: When and how operators expose workspace secrets directly to the agent container's environment, the threat model that follows, and how the UI signals which agents are trusted.
sidebar:
  order: 3
---

x1agent has **three credential-attachment zones**, each with a different identity model and threat surface.

| Zone | Plaintext lands in | Identity at the API | Compatible agent kinds | Use when |
|---|---|---|---|---|
| **1 · MCP-mediated** | The MCP server's container only | The workspace, configured by admin | Any (worker / scheduled / orchestrator) | Third-party API keys consumed via a stdio MCP tool (Linear self-hosted, in-house tool servers) |
| **2 · Agent env** | The agent container's `process.env` | The workspace, as the agent's principal | Any | Credentials the agent itself needs to operate (its own model API key, its own GitHub PAT, deploy tokens) |
| **3 · Per-user OAuth** | Server-side at the MCP provider | The user driving the current session | **Worker only** | Hosted MCPs that authenticate end-users (Mercury, Notion, Slack-as-user, Linear's hosted server) |

Zone 1 is documented in [MCP servers](/providers/mcp-servers). Zone 3 is documented there too. This page is about **Zone 2**.

## Why three zones

The three zones answer three different questions about credentials:

- **Zone 1**: "Who at the API is being called?" → the workspace, hidden behind a tool boundary so the LLM never sees the secret.
- **Zone 2**: "Who is the agent acting AS?" → the workspace, with the agent itself holding the credential because it needs `bash` / `git push` / `kubectl apply` to just work.
- **Zone 3**: "Who is the human currently asking the agent to do this?" → that specific user, authenticated via OAuth at session-launch, with the bearer never reaching the agent process. Restricted to **worker (interactive) agents** — at 3 AM with no human present, there's no one to act AS, so orchestrators and scheduled agents can't use Zone 3.

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

At session-start the api decrypts each referenced workspace secret
(AES-256-GCM, master key from `WORKSPACE_SECRETS_MASTER_KEY`), packs
the (env-name → plaintext) pairs into a freshly minted Kubernetes
Secret named `x1-session-creds-{shortId}`, and points the agent
container's `envFrom` at it. Plaintext does not appear in the Job
manifest, but it does appear briefly in the api process's memory
(during decrypt) and in etcd (in the per-session Secret) until the
session ends and the Secret is deleted. Cluster etcd encryption-at-rest
is required for at-rest protection.

Once the agent boots, everything it runs (bash, the LLM's tool calls,
child processes) inherits the env via the standard `envFrom` mechanism.

## The threat model

Anything the agent can run can read every Zone 2 var. Concretely:

- The LLM can be prompt-injected. A successful injection that gains shell access reads every Zone 2 secret with one `env` call.
- Tool output is logged. `gh push` writes credential headers to stderr that flow to session events, Sentry, and audit logs. Sanitize at source if this matters; rotate if a leak is suspected.
- Sub-agents inherit the env. An agent that spawns child processes hands every Zone 2 var to every child unless the parent strips them.

In short: Zone 2 is a **trust grant from the operator to the agent**. The operator is saying "I want this agent to act with these credentials." Treat it like adding a key to a CI runner — necessary for some workflows, but every consumer of that runner's output is a potential exfil channel.

### What stays in the api's compromise blast radius

Because the api decrypts workspace secrets in-process to materialize
them into per-session Secrets, a compromise of the api process gives
an attacker access to the master key AND the ability to decrypt every
workspace secret in the install. Rotate every workspace secret after a
suspected api compromise — not just the ones bound to live sessions.

## Visual signals

Agents that have any Zone 2 secrets attached display an
**operator-injected credentials** badge. The badge is computed from
`hasAnyBindings` on the agent-env binding repository (see
`packages/domains/agent-env/src/ports/binding-repository.ts`).

(TODO: confirm exact UI placement — agent detail header, sessions list
row, agent edit screen — matches the implementation. Reported by an
audit in 2026-05; flag for UI maintainer to verify.)

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
